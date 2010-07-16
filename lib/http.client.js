require.paths.unshift(__dirname);
var url = require('url'),
	crypto = require('crypto'),
	Buffer = require('buffer').Buffer,
	inherits = require('sys').inherits,
	EventEmitter = require('events').EventEmitter,
	grappler = require('grappler');

require('../deps/cookie-node').secret = null;

function isAllowed(allowedOrigins, origin) {
	if (Array.isArray(allowedOrigins))
		return allowedOrigins.some(isAllowed, origin);
	else {
		var originParts = url.parse(arguments.length != 3 ? origin : this);
		if (typeof allowedOrigins == "string") {
			var allowedHost = allowedOrigins.split(":"),
				allowedPort = (allowedHost.length == 2 ? allowedHost[1] : '*');
			allowedHost = allowedHost[0];
		}
		originParts.port = originParts.port || 80;

		return (allowedOrigins instanceof RegExp && (arguments.length != 3 ? origin : this).match(allowedOrigins)) ||
			   ( (allowedHost == '*' || allowedHost == originParts.hostname) &&
			     (allowedPort == '*' || allowedPort == originParts.port) );
	}
}

function pack(num) {
	var result = '';
	result += String.fromCharCode(num >> 24 & 0xFF);
	result += String.fromCharCode(num >> 16 & 0xFF);
	result += String.fromCharCode(num >> 8 & 0xFF);
	result += String.fromCharCode(num &	0xFF);
	return result;
}

var HttpClient = function(req, res) {
	this._request = req;
	this._response = res;
	var server = req.connection.client.server;
	var self = this;

	// Perform manual inheritance from the Client base class
	grappler.mixin(this, req.connection.client);

	// Check for a permitted origin
	if (req.headers.origin && !isAllowed(server.options.origins, req.headers.origin)) {
		res.writeHead(403);
		res.end();
		self.disconnect();
		return;
	}

	// Check for a websocket request
	if (self.state & grappler.STATE.PROTO_WEBSOCKET) {
		var draft = (typeof req.headers['sec-websocket-key1'] != 'undefined' &&
					 typeof req.headers['sec-websocket-key2'] != 'undefined' ? 76 : 75),
			outgoingdata = ['HTTP/1.1 101 Web' + (draft == 75 ? ' ' : '') + 'Socket Protocol Handshake', 
							'Upgrade: WebSocket', 
							'Connection: Upgrade'],
			inBuffer = null;

		server.options.logger('HttpClient :: Using Websocket draft ' + draft + ' for client id ' + self.id + '.', grappler.LOG.INFO);

		if (draft == 75) {
			outgoingdata = outgoingdata.concat(['WebSocket-Origin: ' + req.headers.origin, 'WebSocket-Location: ws://' + req.headers.host + req.url]);
			outgoingdata = outgoingdata.concat(['', '']).join('\r\n');
		} else if (draft == 76) {
			var strkey1 = req.headers['sec-websocket-key1'],
				strkey2 = req.headers['sec-websocket-key2'],
				key1 = parseInt(strkey1.replace(/[^\d]/g, ""), 10),
				key2 = parseInt(strkey2.replace(/[^\d]/g, ""), 10),
				spaces1 = strkey1.replace(/[^\ ]/g, "").length,
				spaces2 = strkey2.replace(/[^\ ]/g, "").length;

			if (spaces1 == 0 || spaces2 == 0 || key1 % spaces1 != 0 || key2 % spaces2 != 0 && arguments[2].length == 8) {
				server.options.logger('HttpClient :: Websocket request contained an invalid key. Closing connection.', grappler.LOG.WARN);
				self.disconnect();
				return;
			}

			outgoingdata = outgoingdata.concat(['Sec-WebSocket-Origin: ' + req.headers.origin, 'Sec-WebSocket-Location: ws://' + req.headers.host + req.url]);
			if (req.headers['Sec-WebSocket-Protocol'])
				outgoingdata = outgoingdata.concat(['Sec-WebSocket-Protocol: ' + req.headers['Sec-WebSocket-Protocol']]);

			var hash = crypto.createHash('md5');
			hash.update(pack(parseInt(key1/spaces1)));
			hash.update(pack(parseInt(key2/spaces2)));
			hash.update(arguments[2].toString('binary'));
			outgoingdata = outgoingdata.concat(['', '']).join('\r\n') + hash.digest('binary');
		}

		server.emit('connection', this);
		req.connection.setNoDelay(true);
		req.connection.setKeepAlive(true, 0);
		req.connection.write(outgoingdata, (draft == 75 ? 'ascii' : 'binary'));

		req.connection.addListener('end', function() { self.emit('disconnected'); });
		req.connection.addListener('data', function(data) {
			var beginMarker = 0, endMarker = (draft == 75 ? 65533 : 255), curIdx, tmp;
			if (!inBuffer || inBuffer.length == 0) {
				inBuffer = new Buffer(data.length);
				data.copy(inBuffer, 0, 0, data.length);
			} else {
				tmp = new Buffer(inBuffer.length + data.length);
				inBuffer.copy(tmp, 0, 0, inBuffer.length);
				data.copy(tmp, tmp.length, 0, data.length);
				inBuffer = tmp;
			}
			while ((curIdx = inBuffer.indexOf(endMarker)) > -1) {
				if (inBuffer[0] != beginMarker) {
					server.options.logger('HttpClient :: Websocket data incorrectly framed by UA. Closing connection.', grappler.LOG.WARN);
					self.disconnect();
					return;
				}
				tmp = new Buffer(curIdx-1);
				inBuffer.copy(tmp, 0, 1, curIdx);
				self.emit('data', tmp);
				inBuffer = inBuffer.slice(curIdx+1, inBuffer.length);
			}
		});
	} else { // Plain HTTP connection
		switch (req.method.toUpperCase()) {
			case "GET":
				var isMultipart = (req.headers['x-multipart'] || req.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
					isSSEDOM = (req.headers.accept.indexOf('application/x-dom-event-stream') > -1),
					isSSE = (req.headers.accept.indexOf('text/event-stream') > -1 || isSSEDOM);
				res.setKeepAlive(true, 5000);
				res.setSecureCookie('grappler', self.id);
				if (isMultipart) { // Multipart
					server.options.logger('HttpClient :: Using multipart for client id ' + self.id + '.', grappler.LOG.INFO);
					res.setNoDelay(true);
					res.useChunkedEncodingByDefault = false;
					res.writeHead(200, {
						'Content-Type': 'multipart/x-mixed-replace;boundary="grappler"',
						'Connection': 'keep-alive'
					});
					res.write("--grappler\n");
				} else if (isSSE) { // Server-Side Events
					server.options.logger('HttpClient :: Using server-side events for client id ' + self.id + '.', grappler.LOG.INFO);
					res.writeHead(200, {
						'Content-Type': (isSSEDOM ? 'application/x-dom-event-stream' : 'text/event-stream'),
						'Expires': 'Fri, 01 Jan 1990 00:00:00 GMT',
						'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
						'Pragma': 'no-cache'
					});
					res.write(": grappler stream\n\n"); // no retry field for now...
					res.connection.setTimeout(0);
					res.connection.removeAllListeners('timeout'); // remove the server's protocol detection timeout listener
					res.connection.setTimeout(5000);
					res.connection.addListener('timeout', function() {
						res.write(":\n\n"); // send a comment line to keep the connection alive, especially for when client is behind a proxy
						res.connection.setTimeout(0); // unnecessary?
						res.connection.setTimeout(5000);
					});
				} else // Long poll
					server.options.logger('HttpClient :: Using long polling for client id ' + self.id + '.', grappler.LOG.INFO);
				server.emit('connection', this);
				req.connection.addListener('end', function() { self.emit('disconnected'); });
			break;
			case "POST":
				var cookie;
				// Authenticate the validity of the "send message" request as best as we can
				if (!(cookie = req.getSecureCookie('grappler')) || typeof server.connections[cookie] == 'undefined' ||
					req.connection.remoteAddress == server.connections[cookie].socket.remoteAddress ||
					!(server.connections[cookie].state & grappler.STATE.PROTO_HTTP)) {
						server.options.logger('HttpClient :: Invalid POST request due to bad cookie: ' + (cookie ? cookie : '(cookie not set)'), grappler.LOG.WARN);
						self.disconnect();
						return;
				}
				var buffer = null;
				req.addListener('data', function(data) {
					if (!buffer) {
						buffer = new Buffer(data.byteLength);
						data.copy(buffer, 0, 0, data.byteLength);
					} else {
						var tmp = new Buffer(buffer.byteLength + data.byteLength);
						data.copy(tmp, buffer.byteLength, 0, data.byteLength);
						buffer = tmp;
					}
				});
				req.addListener('end', function() {
					res.writeHead(200);
					res.end();
					self.emit('data', buffer);
				});
			break;
			case "OPTIONS": // preflighted cross-origin request (see: https://developer.mozilla.org/en/HTTP_access_control)
				var headers = {};
				headers['Access-Control-Allow-Origin'] = req.headers.origin;
				headers['Access-Control-Allow-Credentials'] = 'true';
				if (req.headers['Access-Control-Request-Headers'])
					headers['Access-Control-Allow-Headers'] = req.headers['Access-Control-Request-Headers'];
				if (req.headers['Access-Control-Request-Method'])
					headers['Access-Control-Allow-Methods'] = req.headers['Access-Control-Request-Method'];
				res.writeHead(200, headers);
				res.end();
				self.disconnect();
				return;
			break;
			default: // Unknown Method
				res.writeHead(405);
				res.end();
				self.disconnect();
				return;
			break;
		}
	}
};

HttpClient.prototype.write = function(data, encoding) {
	var isMultipart = (this._request.headers['x-multipart'] || this._request.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
		isSSEDOM = (this._request.headers.accept.indexOf('application/x-dom-event-stream') > -1),
		isSSE = (this._request.headers.accept.indexOf('text/event-stream') > -1 || isSSEDOM);

	if (this.state & grappler.STATE.PROTO_WEBSOCKET) { // websocket
		this._request.connection.write('\u0000', 'binary');
		this._request.connection.write(data, encoding);
		this._request.connection.write('\uffff', 'binary');
	} else if (isMultipart) { // multipart
		this._response.write("Content-Type: " + (encoding == 'binary' ? "application/octet-stream" : "text/plain") + "\n\n");
		this._response.write(data, encoding);
		this._response.write("\n--grappler\n");
	} else if (isSSE) { // server-sent events -- via JS or DOM
		if (isSSEDOM)
			this._response.write("Event: " + (this._request.headers['x-event'] ? this._request.headers['x-event'] : 'grappler-data') + "\n");
		this._response.write("data: ");
		this._response.write(data, encoding);
		this._response.write("\n\n");
	} else { // long poll
		this._response.writeHead(200, {
			'Content-Type': (data instanceof Buffer && (!encoding || encoding == 'binary') ? "application/octet-stream" : "text/plain"),
			'Content-Length': (data instanceof Buffer ? data.byteLength : data.length)
		});
		this._response.end(data, encoding);
	}
};
inherits(HttpClient, grappler.Client);
exports.HttpClient = HttpClient;

// Handy-dandy Buffer methods
Buffer.prototype.indexOf = function(value) {
	var index = -1;
	value = (typeof value == 'number' ? value : String.charCodeAt(value[0]));
	for (var i=0,len=this.length; i<len; ++i) {
		if (this[i] == value) {
			index = i;
			break;
		}
	}
	return index;
};
Buffer.prototype.lastIndexOf = function(value) {
	var index = -1;
	value = (typeof value == 'number' ? value : String.charCodeAt(value[0]));
	for (var i=this.length-1; i>=0; --i) {
		if (this[i] == value) {
			index = i;
			break;
		}
	}
	return index;
};