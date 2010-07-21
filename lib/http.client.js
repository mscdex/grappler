require.paths.unshift(__dirname);
var url = require('url'),
	crypto = require('crypto'),
	Buffer = require('buffer').Buffer,
	EventEmitter = require('events').EventEmitter,
	sys = require('sys'),
	http = require('http'),
	grappler = require('grappler');

require('../deps/cookie-node').secret = null;

function isAllowed(allowedOrigins, testOrigin) {
	return allowedOrigins.some(function(origin) {
		var originParts = url.parse(testOrigin);
		originParts.port = originParts.port || 80;
		return ( (origin[0] == '*' || origin[0] == originParts.hostname) &&
				 (origin[1] == '*' || origin[1] == originParts.port) );
	});
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
	// Manual inheritance from the Client base class :-\
	grappler.mixin(this, req.connection.client);

	var self = this;
	var server = self.server;
	this._request = req;
	this._response = res;

	// Ignore favicon requests since they weren't handled by the user's callback
	if (req.url == "/favicon.ico") {
		res.writeHead(404);
		res.end();
		return;
	}

	// Check for a permitted origin
	if (req.headers.origin && !isAllowed(server.options.origins, req.headers.origin)) {
		server.options.logger('HttpClient :: Denied client ' + self.id + ' due to disallowed origin (\'' + req.headers.origin + '\')', grappler.LOG.INFO);
		if (res instanceof http.ServerResponse) {
			res.writeHead(403);
			res.end();
		}
		req.connection.destroy();
		return;
	}

	if (req.headers.upgrade) {
		if (req.headers.upgrade == 'WebSocket')
			self.state |= grappler.STATE.PROTO_WEBSOCKET;
		else {
			self.disconnect();
			server.options.logger('HttpClient :: Unrecognized HTTP upgrade request: ' + req.headers.upgrade, grappler.LOG.WARN);
		}
	}

	// Check for a WebSocket request
	if (self.state & grappler.STATE.PROTO_WEBSOCKET) {
		self._makePerm();
		var draft = (typeof req.headers['sec-websocket-key1'] != 'undefined' &&
					 typeof req.headers['sec-websocket-key2'] != 'undefined' ? 76 : 75),
			outgoingdata = ['HTTP/1.1 101 Web' + (draft == 75 ? ' ' : '') + 'Socket Protocol Handshake', 
							'Upgrade: WebSocket', 
							'Connection: Upgrade'],
			inBuffer = null;

		server.options.logger('HttpClient :: Using WebSocket draft ' + draft + ' for client id ' + self.id, grappler.LOG.INFO);

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
				server.options.logger('HttpClient :: WebSocket request contained an invalid key. Closing connection.', grappler.LOG.WARN);
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
		self._makePerm();

		req.connection.setNoDelay(true);
		req.connection.setKeepAlive(true, server.options.pingInterval);
		req.connection.write(outgoingdata, (draft == 75 ? 'ascii' : 'binary'));

		if (req.connection.readyState == 'open')
			server.emit('connection', this);

		req.connection.addListener('data', function(data) {
			var beginMarker = 0, endMarker = 255, curIdx, tmp;
			if (!inBuffer || inBuffer.length == 0) {
				inBuffer = new Buffer(data.length);
				data.copy(inBuffer, 0, 0, data.length);
			} else {
				tmp = new Buffer(inBuffer.length + data.length);
				inBuffer.copy(tmp, 0, 0, inBuffer.length);
				data.copy(tmp, inBuffer.length, 0, data.length);
				inBuffer = tmp;
			}
			while ((curIdx = inBuffer.indexOf(endMarker)) > -1) {
				// Closing handshake
				if (inBuffer[0] == endMarker && inBuffer[1] && inBuffer[1] == beginMarker) {
					self.disconnect();
					return;
				}
				if (inBuffer[0] != beginMarker) {
					server.options.logger('HttpClient :: WebSocket data incorrectly framed by UA. Closing connection.', grappler.LOG.WARN);
					self.disconnect();
					return;
				}
				tmp = new Buffer(curIdx-1);
				inBuffer.copy(tmp, 0, 1, curIdx);
				server.emit('data', tmp, self);
				inBuffer = inBuffer.slice(curIdx+1, inBuffer.length);
			}
		});
	} else { // Plain HTTP connection (everything else)
		switch (req.method.toUpperCase()) {
			case "GET":
				var isMultipart = (req.headers.accept && req.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
					isSSEDOM = (req.headers.accept && req.headers.accept.indexOf('application/x-dom-event-stream') > -1),
					isSSE = ((req.headers.accept && req.headers.accept.indexOf('text/event-stream') > -1) || isSSEDOM);
				req.connection.setKeepAlive(true, server.options.pingInterval);
				if (isMultipart) { // Multipart (x-mixed-replace)
					res.setSecureCookie('grappler', self.id);
					self._makePerm();
					server.options.logger('HttpClient :: Using multipart for client id ' + self.id, grappler.LOG.INFO);
					req.connection.setNoDelay(true);
					res.useChunkedEncodingByDefault = false;
					res.writeHead(200, {
						'Content-Type': 'multipart/x-mixed-replace;boundary="grappler"',
						'Connection': 'keep-alive',
						'Expires': 'Fri, 01 Jan 1990 00:00:00 GMT',
						'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
						'Pragma': 'no-cache'
					});
					res.write("--grappler\n");
					self.write(""); // send a ping packet immediately
					req.connection.removeAllListeners('timeout'); // remove the server's protocol detection timeout listener
					req.connection.setTimeout(server.options.pingInterval);
					req.connection.addListener('timeout', function() {
						self.write("");
						req.connection.setTimeout(server.options.pingInterval);
					});
					server.emit('connection', this);
				} else if (isSSE) { // Server-Side Events
					res.setSecureCookie('grappler', self.id);
					self._makePerm();
					server.options.logger('HttpClient :: Using server-side events for client id ' + self.id, grappler.LOG.INFO);
					res.writeHead(200, {
						'Content-Type': (isSSEDOM ? 'application/x-dom-event-stream' : 'text/event-stream'),
						'Expires': 'Fri, 01 Jan 1990 00:00:00 GMT',
						'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
						'Pragma': 'no-cache'
					});
					res.write(": grappler stream\n\n"); // no retry field for now...
					req.connection.setTimeout(0);
					req.connection.removeAllListeners('timeout'); // remove the server's protocol detection timeout listener
					req.connection.setTimeout(server.options.pingInterval);
					req.connection.addListener('timeout', function() {
						res.write(":\n\n"); // send a comment line to keep the connection alive, especially for when client is behind a proxy
						req.connection.setTimeout(server.options.pingInterval);
					});
					server.emit('connection', this);
				} else { // Long poll
					var cookie = undefined;
					try {
						cookie = req.getSecureCookie('grappler');
					} catch(e) {}

					if (!cookie) {
						res.setSecureCookie('grappler', self.id);
						// Reset connection to make sure the session cookie is set
						self.write("");
					} else {
						var isSubsequent = false;
						if (!server.connections[cookie]) {
							// Initial connection
							server.connections[cookie] = this;
							server.emit('connection', this);
							server.connections[cookie]._checkQueue = function() {
								// Send any pending data sent to this long poll client
								if (server.connections[cookie]._queue && server.connections[cookie]._queue.length)
									server.connections[cookie].write();
							};
						} else {
							// The original HttpClient just needs to reuse subsequent connections'
							// ServerRequest and ServerResponse objects so that we can still write
							// the client using the original HttpClient instance
							server.connections[cookie]._request = self._request;
							server.connections[cookie]._response = self._response;
							isSubsequent = true;
						}
						// Set a timeout to assume the client has permanently disconnected if they
						// do not reconnect after a certain period of time
						server.connections[cookie]._request.connection.addListener('end', function() {
							if (server.connections[cookie].pollWaiting)
								clearTimeout(server.connections[cookie].pollWaiting);
							server.connections[cookie].pollWaiting = setTimeout(function() {
								if (server.connections[cookie]._request.connection.readyState != 'open') {
									try {
										server.connections[cookie].emit('close');
										req.connection.end();
										req.connection.destroy();
										delete server.connections[cookie];
									} catch(e) {}
								}
							}, server.options.pingInterval);
						});
						server.options.logger('HttpClient :: Client prefers id of ' + cookie + ' instead of ' + self.id + (isSubsequent ? ' (subsequent)' : ''), grappler.LOG.INFO);
						server.options.logger('HttpClient :: Using long polling for client id ' + cookie, grappler.LOG.INFO);
					}
				}
			break;
			case "POST":
				var cookie;
				// Authenticate the validity of the "send message" request as best as we can
				if (!(cookie = req.getSecureCookie('grappler')) || typeof server.connections[cookie] == 'undefined' ||
					req.connection.remoteAddress != server.connections[cookie].remoteAddress ||
					!(server.connections[cookie].state & grappler.STATE.PROTO_HTTP)) {
						server.options.logger('HttpClient :: Invalid POST request due to bad cookie: ' + (cookie ? cookie : '(cookie not set)'), grappler.LOG.WARN);
						self.disconnect();
						return;
				}
				var inBuffer = null;
				req.addListener('data', function(data) {
					if (!inBuffer || inBuffer.length == 0) {
						inBuffer = new Buffer(data.length);
						data.copy(inBuffer, 0, 0, data.length);
					} else {
						var tmp = new Buffer(inBuffer.length + data.length);
						inBuffer.copy(tmp, 0, 0, inBuffer.length);
						data.copy(tmp, inBuffer.length, 0, data.length);
						inBuffer = tmp;
					}
				});
				req.addListener('end', function() {
					res.writeHead(200);
					res.end();
					self.disconnect();
					server.emit('data', inBuffer, server.connections[cookie]);
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
			break;
			default: // Unknown Method
				res.writeHead(405);
				res.end();
			break;
		}
	}
};
sys.inherits(HttpClient, EventEmitter);
exports.HttpClient = HttpClient;

HttpClient.prototype._makePerm = function() {
	this.state = (this.state & ~grappler.STATE.TEMP);
	this.server.connections[this.id] = this; // lazy add to connections list
};

HttpClient.prototype.write = function(data, encoding) {
	var isMultipart = (this._request.headers.accept && this._request.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
		isSSEDOM = (this._request.headers.accept && this._request.headers.accept.indexOf('application/x-dom-event-stream') > -1),
		isSSE = ((this._request.headers.accept && this._request.headers.accept.indexOf('text/event-stream') > -1) || isSSEDOM),
		self = this;

	try {
		if (this.state & grappler.STATE.PROTO_WEBSOCKET) { // WebSocket
			if (data.length > 0) {
				this._request.connection.write('\x00', 'binary');
				this._request.connection.write(data, 'utf8');
				this._request.connection.write('\xff', 'binary');
			}
		} else if (isMultipart) { // multipart (x-mixed-replace)
			this._response.write("Content-Type: " + (data instanceof Buffer && (!encoding || encoding == 'binary') ? "application/octet-stream" : "text/plain") + "\nContent-Length: " + data.length + "\n\n");
			this._response.write(data, encoding);
			this._response.write("\n--grappler\n");
		} else if (isSSE) { // Server-Sent Events -- via JS or DOM
			if (isSSEDOM)
				this._response.write("Event: grappler-data\n");
			this._response.write("data: ");
			this._response.write(data, encoding);
			this._response.write("\n\n");
		} else { // long poll
			if (!this._queue)
				this._queue = [];

			// Always append to the initial connection's write queue.
			// Queueing every piece of data provides consistency and correct ordering of incoming writes, no matter
			// if the long poll client is in the process of reconnecting or not.
			//
			// TODO: Have a callback for write to know if the message was successfully sent?
			//       For example, a bunch of writes could be queued up for a long poll client, but they never end up
			//       reconnecting -- thus losing all of those messages. However, it is currently assumed they were
			//       in fact sent successfully. We should let the sender know they were not received by the recipient.
			if (arguments.length > 0)
					this._queue.push([data, encoding]);
			
			if (this._request.connection.readyState == 'open') {
				data = this._queue.shift();
				encoding = data[1];
				data = data[0];
				this._response.writeHead(200, {
					'Content-Type': (data instanceof Buffer && (!encoding || encoding == 'binary') ? "application/octet-stream" : "text/plain"),
					'Content-Length': data.length,
					'Connection': 'keep-alive',
					'Expires': 'Fri, 01 Jan 1990 00:00:00 GMT',
					'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
					'Pragma': 'no-cache'
				});
				this._response.end(data, encoding);
			}
			process.nextTick(function() { self._checkQueue(); });
			
		}
	} catch(e) {} // silently trap "stream is not writable" errors for now
};

HttpClient.prototype.disconnect = function() {
	var isMultipart = (this._request.headers.accept && this._request.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
		isSSEDOM = (this._request.headers.accept && this._request.headers.accept.indexOf('application/x-dom-event-stream') > -1),
		isSSE = ((this._request.headers.accept && this._request.headers.accept.indexOf('text/event-stream') > -1) || isSSEDOM);

	if (!(this.state & grappler.STATE.PROTO_WEBSOCKET) && !isMultipart && !isSSE) { // long poll
		// For when we disconnect without having previously sent anything.
		// Without this, the browser (Chrome at least) seems to try to auto re-connect once more?
		if (!this._response._header) {
			this._response.writeHead(200, { 'Connection': 'close' });
			this._response.end();
		}
	} else if (this.state & grappler.STATE.PROTO_WEBSOCKET) {
		// Send closing handshake
		var buffer = new Buffer(2);
		buffer[0] = 255;
		buffer[1] = 0;
		this.write(buffer);
	}

	try {
		this.socket.end();
		this.socket.destroy();
	} catch (e) {}

	if ((this.state & grappler.STATE.ACCEPTED) && !(this.state & grappler.STATE.TEMP))
		this.emit('close');

	// Setting the entry in the connections map to null/undefined supposedly performs better
	// than using 'delete' (leads to a "slow case"). However, this method also means you'll have an
	// increasingly large map filled with empty spots. :-\
	/*if (Object.keys(this.server.connections).indexOf(this.id) > -1) {
		this.server.connections[this.id] = undefined;
		// Hide the connection from "showing" in the connections hash
		Object.defineProperty(this.server.connections, this.id, { enumerable: false });
	}*/
	if (this.server.connections[this.id] && ((this.state & grappler.STATE.PROTO_WEBSOCKET) || isMultipart || isSSE)) {
		exists = true;
		// TODO: delete on nextTick() instead?
		delete this.server.connections[this.id];
	}
};




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