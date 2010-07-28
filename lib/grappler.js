require.paths.unshift(__dirname);
var sys = require('sys'),
	http = require('http'),
	fs = require('fs'),
	EventEmitter = require('events').EventEmitter,
	TcpClient = require('tcp.client').TcpClient,
	HttpClient;

// Dynamically generate the secret for securing HTTP cookies only once.
// We could keep from having to read in http.client.js twice every time
// if we just had some method to force require() to reload a single module
// from disk (only if HttpClient.cookieSecret == null).
try {
	var clientCode = fs.readFileSync(__dirname + '/http.client.js').toString();
	if (clientCode.indexOf(".secret = null") > -1)
		fs.writeFileSync(__dirname + '/http.client.js', clientCode.replace(".secret = null", ".secret = '" + Math.floor(Math.random()*1e9).toString() + (new Date()).getTime().toString() + Math.floor(Math.random()*1e9).toString() + "'"));
	HttpClient = require('http.client').HttpClient;
} catch (e) {
	throw e;
}

var LOG = exports.LOG = {
	INFO: 1,
	WARN: 2,
	ERROR: 3
};

var STATE = exports.STATE = {
	ACCEPTED: 1,
	TEMP: 2,
	PROTO_HTTP: 4,
	PROTO_WEBSOCKET: 8,
	PROTO_TCP: 16
};

// From jQuery.extend in the jQuery JavaScript Library v1.3.2
// Copyright (c) 2009 John Resig
// Dual licensed under the MIT and GPL licenses.
// http://docs.jquery.com/License
// Modified for node.js (formerly process.mixin)
var mixin = exports.mixin = function() {
  // copy reference to target object
  var target = arguments[0] || {}, i = 1, length = arguments.length, deep = false, source;

  // Handle a deep copy situation
  if ( typeof target === "boolean" ) {
    deep = target;
    target = arguments[1] || {};
    // skip the boolean and the target
    i = 2;
  }

  // Handle case when target is a string or something (possible in deep copy)
  if ( typeof target !== "object" && !(typeof target === 'function') )
    target = {};

  // mixin process itself if only one argument is passed
  if ( length == i ) {
    target = GLOBAL;
    --i;
  }

  for ( ; i < length; i++ ) {
    // Only deal with non-null/undefined values
    if ( (source = arguments[i]) != null ) {
      // Extend the base object
	  //Object.getOwnPropertyNames(source).forEach(function(k){
	  for (var j=0, k, keys=Object.getOwnPropertyNames(source), len=keys.length; j<len; ++j) {
		k = keys[j];
        var d = Object.getOwnPropertyDescriptor(source, k) || {value: source[k]};
        if (d.get) {
          target.__defineGetter__(k, d.get);
          if (d.set) {
            target.__defineSetter__(k, d.set);
          }
        }
        else {
          // Prevent never-ending loop
          if (target === d.value) {
            return;
          }

          if (deep && d.value && typeof d.value === "object") {
            target[k] = mixin(deep,
              // Never move original objects, clone them
              source[k] || (d.value.length != null ? [] : {})
            , d.value);
          }
          else {
            target[k] = d.value;
          }
        }
      }//);
    }
  }
  // Return the modified object
  return target;
};

function noop() { return true; };
function noaction() { return false; };

function parseOrigins(allowedOrigins) {
	if (Array.isArray(allowedOrigins) && arguments.length == 1)
		return allowedOrigins.reduce(parseOrigins, []);
	else {
		var allowedHost = (arguments[1] ? arguments[1].split(":") : allowedOrigins.split(":")),
			allowedPort = (allowedHost.length == 2 ? allowedHost[1] : '*');
		allowedHost = allowedHost[0];
		return (arguments[1] ? allowedOrigins.concat([[allowedHost, allowedPort]]) : [[allowedHost, allowedPort]]);
	}
}

// When calling the Server() constructor, you must either give 1 or 3 arguments. Specify null for any callbacks you
// don't wish to handle or when you want to use the default behavior.
//
// fnHandleNormalHTTP(request, response) is a callback that gives the user a chance to handle any HTTP requests before
// they are assumed to be a "comet" request. If response is written to (i.e. headers are written), then the request will not
// continue to be handled by grappler.
//
// fnAcceptClient(stream) is a callback that determines if a given net.Stream is permitted to stay connected to the server,
// judging by the callback's return value. If a callback is not supplied, the default action is to accept all clients.
function Server(options/*, fnHandleNormalHTTP, fnAcceptClient*/) {
	EventEmitter.call(this);

	var logger;
	var cbAccept = (arguments[2] && typeof arguments[2] == 'function' ? arguments[2] : noop);
	var cbHandleHTTP = (arguments[1] && typeof arguments[1] == 'function' ? arguments[1] : noaction);
	var server;
	var connections = this.connections = {};
	var self = this;

	this.options = mixin({
		logger: noop, // function that receives debug messages of various kinds and passes in two arguments: the message and the
		              // debug level of the message (denoted by the LOG.* "constants")
		origins: "*:*", // which clients are allowed to connect? the port portion is only pertinent for HTTP clients
		pingInterval: 3000, // time in ms to ping the client for HTTP connections that need to do so
		detectTimeout: 0 // time in ms to wait for an HTTP response before assuming a plain TCP client. 0 disables this feature.
	}, options || {});

	this.options.origins = parseOrigins(this.options.origins);
	logger = this.options.logger;
	server = this._server = http.createServer();

	// Make sure our connection handler happens before the built-in one
	server.listeners('connection').unshift(function(socket) {
		var flashSocketTest = "";
		socket.addListener('data', function(buffer) {
			flashSocketTest += buffer.toString();
			if (flashSocketTest.indexOf("<policy-file-request/>") == 0) {
				var allowedOrigins = self.options.origins.reduce(function(prev, cur) {
					return prev + '<allow-access-from domain="' + cur[0] + '" to-ports="' + cur[1] + '"/>';
				}, "");
				socket.end('<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd"><cross-domain-policy>' + allowedOrigins + '</cross-domain-policy>');
				socket.destroy();
			}
		});
		// Override http.Server's built-in socket timeout
		socket.setTimeout(0);
		if (self.options.detectTimeout > 0) {
			socket.removeAllListeners('timeout');
			socket.addListener('timeout', function() {
				// Assume a non-HTTP client if we haven't received a valid HTTP request
				// in the time determined by options.detectTimeout
				if (!(socket.client.state & STATE.PROTO_HTTP)) {
					socket.client.state |= STATE.PROTO_TCP;
					connections[socket.client._id] = new TcpClient(socket.client);
				}
			});
			socket.setTimeout(self.options.detectTimeout);
		}

		socket.client = new Client(self, socket.remoteAddress);

		var fnClose = function() {
			if (socket.isMarked == undefined) {
				if (connections[socket.client._id])
					connections[socket.client._id].disconnect();
				socket.isMarked = true;
				logger('Server :: Connection closed: id == ' + socket.client._id, LOG.INFO);
			}
		};
		socket.addListener('close', fnClose);
		socket.addListener('end', fnClose);

		if (!cbAccept(socket)) {
			// The incoming connection was denied for one reason or another
			socket.destroy();
			logger('Server :: Incoming connection denied: id == ' + socket.client._id, LOG.INFO);
		} else {
			socket.client.state |= STATE.ACCEPTED;
			logger('Server :: Incoming connection accepted: id == ' + socket.client._id, LOG.INFO);
		}
	});
	server.addListener('request', function(req, res) {
		// Check if we have accepted the connection and have decided that this
		// is not a non-HTTP request
		if (req.connection.client.state & STATE.ACCEPTED) {
			req.connection.client.state |= STATE.PROTO_HTTP;
			req.connection.setTimeout(0);
			req.connection.removeAllListeners('timeout');
			req.connection.removeAllListeners('data');

			cbHandleHTTP(req, res);

			// Let grappler handle this request if it wasn't already handled by the callback
			if (!res._header)
				new HttpClient(req, res);
			else
				logger('Server :: HTTP connection handled by callback. id == ' + req.connection.client._id, LOG.INFO);
		}
	});
	server.addListener('upgrade', function(req, socket, head) {
		if (req.connection.client.state & STATE.ACCEPTED) {
			req.connection.setTimeout(0);
			req.connection.removeAllListeners('timeout');
			req.connection.removeAllListeners('data');

			cbHandleHTTP(req, socket);

			// Let grappler handle this request if it wasn't already handled by the callback
			if (req.connection.readyState == 'open')
				new HttpClient(req, socket, head);
			else
				logger('Server :: HTTP Upgrade request handled by callback. id == ' + req.connection.client._id, LOG.INFO);
		}
	});

	server.addListener('error', function(err) {
		self.emit('error', err);
	});

	this.shutdown = function() {
		server.close();
		for (var i=0,keys=Object.keys(connections),len=keys.length; i<len; ++i)
			connections[keys[i]].disconnect();
	};
}
sys.inherits(Server, EventEmitter);
exports.Server = Server;

Server.prototype.listen = function(port, host) {
	this._server.listen(port, host);
};

Server.prototype.broadcast = function(data, except) {
	for (var i=0,keys=Object.keys(this.connections),len=keys.length; i<len; ++i)
		if (!except || (keys[i] != except && this.connections[keys[i]] != except))
			this.connections[keys[i]].write(data);
};

function Client(srv, ip) {
	this._id = Math.floor(Math.random()*1e5).toString() + (new Date()).getTime().toString();
	this.state = STATE.TEMP;
	this.remoteAddress = ip;
	var server = srv;

	this.__defineGetter__('server', function() { return server; });

	this.broadcast = function(data) {
		server.broadcast(data, this._id);
	};
}
exports.Client = Client;