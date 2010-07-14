require.paths.unshift(__dirname);
var sys = require('sys'),
	http = require('http'),
	EventEmitter = require('events').EventEmitter,
	TcpClient = require('tcp.client').TcpClient,
	HttpClient;

// Dynamically generate the secret for securing HTTP cookies only once.
// We could keep from having to read in http.client.js twice every time
// if we just had some method to force require() to reload a single module
// from disk (only if HttpClient.cookieSecret == null).
try {
	var clientCode = fs.readFileSync(__dirname + '/http.client.js').toString();
	if (clientCode.indexOf("var cookieSecret = null;") > -1)
		fs.writeFileSync(__dirname + '/http.client.js', clientCode.replace("var cookieSecret = null;", "var cookieSecret = '" + (new Date()).getTime() + Math.floor(Math.random()*99999999999+1) + Math.floor(Math.random()*99999999999+1) + "';"));
	HttpClient = require('http.client').HttpClient;
} catch (e) {
	throw e;
}

var LOG = {
	INFO: 1,
	WARN: 2,
	ERROR: 4
};

var STATE = {
	ACCEPTED: 1,
	PROTO_HTTP: 2,
	PROTO_TCP: 4,
	PROTO_WEBSOCKET: 8
};

// From jQuery.extend in the jQuery JavaScript Library v1.3.2
// Copyright (c) 2009 John Resig
// Dual licensed under the MIT and GPL licenses.
// http://docs.jquery.com/License
// Modified for node.js (formerly process.mixin)
function mixin() {
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
      });
    }
  }
  // Return the modified object
  return target;
};

function noop() { return true; };

function Server(options) {
	EventEmitter.call(this);

	var logger;
	var cbAccept = (arguments[1] && typeof arguments[1] == 'function' ? arguments[1] : noop);
	var server;
	var connections = this.connections = {};
	var self = this;

	this.options = mixin(options || {}, {
		logger: noop,
		origin: "*:*",
		detectTimeout: 600, // ms
		transportOpts: {}
	});

	logger = this.options.logger;

	server = this._server = http.createServer();
	server.addListener('connection', function(socket) {
		// Override http.Server's built-in socket timeout
		socket.setTimeout(0);
		socket.removeAllListeners('timeout');
		socket.addListener('timeout', function() {
			// Assume a non-HTTP client if we haven't received a valid HTTP request
			// in the time determined by options.detectTimeout
			if (!(socket.client.state & STATE.PROTO_HTTP))
				socket.client.state |= STATE.PROTO_TCP;
			connections[socket.client.id] = new TcpClient(socket.client);
		});
		socket.setTimeout(self.options.detectTimeout);

		socket.client = new Client(socket, self);
		socket.setKeepAlive(true);
		socket.addListener('close', function(had_error) {
			if (had_error)
				logger('Server :: Error encountered during connection closing.', LOG.ERROR);
			logger('Server :: Connection closed: id == ' + socket.client.id, LOG.INFO);
			if (typeof connections[socket.client.id] != 'undefined')
				delete connections[socket.client.id];
			socket.destroy();
			self.emit('disconnect', socket.client);
		});
		if (!cbAccept(socket)) {
			// The incoming connection was denied for one reason or another
			logger('Server :: Incoming connection denied: id == ' + socket.client.id, LOG.INFO);
			socket.destroy();
		} else {
			socket.client.state |= STATE.ACCEPTED;
			logger('Server :: Incoming connection accepted: id == ' + socket.client.id, LOG.INFO);
		}
	});

	//if (typeof transports['http'] != 'undefined') {
		server.addListener('request', function(req, res) {
			// Check if we have accepted the connection and have decided that this
			// is not a non-HTTP request
			if (req.connection.client.state == STATE.ACCEPTED) {
				req.connection.client.state |= STATE.PROTO_HTTP;
				req.connection.setTimeout(0);
				req.connection.removeAllListeners('timeout');

				connections[req.connection.client.id] = new HttpClient(req, res);
			}
		});
	//}
	server.addListener('upgrade', function(request, socket, head) {
		if (request.connection.client.state == STATE.ACCEPTED) {
			request.connection.setTimeout(0);
			request.connection.removeAllListeners('timeout');
			if (request.headers.upgrade != 'WebSocket') {
				request.connection.client.disconnect();
				logger('Server :: Unrecognized HTTP upgrade request: ' + request.headers.upgrade, LOG.WARN);
			}
			request.connection.client.state |= STATE.PROTO_WEBSOCKET;

			connections[request.connection.client.id] = new HttpClient(request, socket, head);
		}
	});

	// Put our connection listener before the built-in one
	var connListeners = server.listeners('connection');
	connListeners.push(connListeners.shift());

	server.addListener('error', function(err) {
		self.emit('error', err);
	});

	this.close = function() {
		server.close();
		for (var i=0,keys=Object.keys(connections),len=keys.length; i<len; ++i)
			connections[keys[i]].disconnect();
		self.emit('close');
	};
}
sys.inherits(Server, EventEmitter);

Server.prototype.listen = function(port, host) {
	this._server.listen(port, host);
};

Server.prototype.broadcast = function(data, except) {
	var except = (typeof except != 'undefined' ? except : null);
	for (var i=0,keys=Object.keys(this.connections),len=keys.length; i<len; ++i)
		if (!except || (keys[i] != except && this.connections[keys[i]] != except))
			this.connections[keys[i]].write(data);
};

exports.Server = Server;

function Client(stream, srv) {
	var id = (new Date()).getTime();
	var state = 0;
	var socket = stream;
	var server = srv;

	this.__defineGetter__('id', function() { return id; });
	this.__defineGetter__('state', function() { return state; });
	this.__defineSetter__('state', function(val) { if (state < STATE.PROTO_HTTP) state = val; });
	this.__defineGetter__('socket', function() { return socket; });
	this.__defineGetter__('server', function() { return server; });
}

Client.prototype.broadcast = function(data) {
	this.server.broadcast(data, this.id);
};

Client.prototype.disconnect = function() {
	try {
		this.socket.destroy();
	catch (e) {}
	delete this.server.connections[this.id];
};

sys.inherits(Client, EventEmitter);

exports.Client = Client;

exports.LOG = LOG;