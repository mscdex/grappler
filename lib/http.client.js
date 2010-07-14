require.paths.unshift(__dirname);
var url = require('url'),
	crypto = require('crypto'),
	Buffer = require('buffer').Buffer,
	inherits = require('sys').inherits;
	grappler = require('grappler');

var cookieSecret = null;

function isAllowed(allowedOrigins, origin) {
	if (Array.isArray(allowedOrigins))
		return allowedOrigins.some(isAllowed, origin);
	else {
		var originParts = url.parse(arguments.length != 3 ? origin : this);
		if (typeof allowedOrigins == "string") {
			var allowedHost = allowedOrigins.split(":"),
				allowedPort = (allowedHost.length == 2 ? allowedHost[1] : 80);
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

	if (req.headers.origin && !isAllowed(req.headers.origin)) {
		res.writeHead(403);
		res.end();
		req.connection.client.disconnect();
		return;
	}

	if (req.connection.client.state & grappler.STATE.PROTO_WEBSOCKET) {
		var draft = (typeof this.request.headers['sec-websocket-key1'] != 'undefined' &&
					 typeof this.request.headers['sec-websocket-key2'] != 'undefined' ? 76 : 75),
			outgoingdata = ['HTTP/1.1 101 Web Socket Protocol Handshake', 
							'Upgrade: WebSocket', 
							'Connection: Upgrade'],
			inBuffer = null;
		if (draft == 75) {
			outgoingdata = outgoingdata.concat(['WebSocket-Origin: ' + req.headers.origin, 'WebSocket-Location: ws://' + req.headers.host + req.url]);
			outgoingdata = outgoingdata.concat(['', '']).join('\r\n');
		} else if (draft == 76) {
			var strkey1 = this.request.headers['sec-websocket-key1'],
				strkey2 = this.request.headers['sec-websocket-key2'],
				key1 = parseInt(strkey1.replace(/[^\d]/g, "")),
				key2 = parseInt(strkey2.replace(/[^\d]/g, "")),
				spaces1 = strkey1.split(" ").length-1,
				spaces2 = strkey2.split(" ").length-1;

			if (spaces1 == 0 || spaces2 == 0 || key1%spaces1 != 0 || key1%spaces1 != 0) {
				server.options.logger('HttpClient :: Websocket request contained an invalid key. Closing connection.');
				req.connection.client.disconnect();
				return;
			}

			outgoingdata = outgoingdata.concat(['Sec-WebSocket-Origin: ' + req.headers.origin, 'Sec-WebSocket-Location: ws://' + req.headers.host + req.url]);
			if (req.headers['Sec-WebSocket-Protocol'])
				outgoingdata = outgoingdata.concat(['Sec-WebSocket-Protocol: ' + req.headers['Sec-WebSocket-Protocol']]);

			var hash = crypto.createHash('md5');
			hash.update('' + this.pack(parseInt(key1/spaces1)) + this.pack(parseInt(key2/spaces2)) + arguments[2].toString('binary'));
			outgoingdata = outgoingdata.concat(['', '']).join('\r\n');
			outgoingdata += hash.digest('binary');
		}
		req.connection.setEncoding('binary');
		req.connection.setNoDelay(true);
		req.connection.setKeepAlive(true, 5000);
		req.connection.write(outgoingdata);
		req.connection.addListener('end', function() { req.connection.client.disconnect(); });
		req.connection.addListener('data', function(data) {
			var beginMarker = '\u0000', endMarker = (draft == 75 ? '\ufffd' : '\u00ff'), curIdx, tmp;
			if (!inBuffer) {
				inBuffer = new Buffer(data.byteLength);
				data.copy(inBuffer, 0, 0, data.byteLength);
			} else {
				tmp = new Buffer(inBuffer.length + data.byteLength);
				inBuffer.copy(tmp, 0, 0, inBuffer.length);
				data.copy(tmp, tmp.length, 0, data.byteLength);
				inBuffer = tmp;
			}
			while ((curIdx = inBuffer.indexOf(endMarker)) > -1) {
				if (inBuffer[0] != beginMarker) {
					server.options.logger('HttpClient :: Websocket data incorrectly framed by UA. Closing connection.');
					req.connection.client.disconnect();
					return;
				}
				tmp = new Buffer(curIdx-1);
				inBuffer.copy(tmp, 0, 1, curIdx);
				self.emit('data', tmp, this);
				inBuffer = (curIdx+1 < inBuffer.length ? inBuffer.slice(curIdx+1, inBuffer.length) : null);
			}
		});
	} else {
		switch (req.method.toUpperCase()) {
			case "GET":
				var isMultipart = (req.headers['x-multipart'] || req.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
					isSSEDOM = (req.headers.accept.indexOf('application/x-dom-event-stream') > -1),
					isSSE = (req.headers.accept.indexOf('text/event-stream') > -1 || isSSEDOM);
				res.setKeepAlive(true, 5000);
				if (isMultipart) {
					res.setNoDelay(true);
					res.useChunkedEncodingByDefault = false;
					res.writeHead(200, {
						'Content-Type': 'multipart/x-mixed-replace;boundary="grappler"',
						'Connection': 'keep-alive'
					});
					res.write("--grappler\n");
				} else if (isSSE) {
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
					
				}
				req.connection.client.server.emit('connection', this);
			break;
			case "POST":
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
					self.emit('data', buffer, this);
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
				req.connection.client.disconnect();
				return;
			break;
			default:
				res.writeHead(405);
				res.end();
				req.connection.client.disconnect();
				return;
			break;
		}
	}
};

HttpClient.prototype.write = function(data, encoding) {
	var isMultipart = (this._request.headers['x-multipart'] || this._request.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
		isSSEDOM = (this._request.headers.accept.indexOf('application/x-dom-event-stream') > -1),
		isSSE = (this._request.headers.accept.indexOf('text/event-stream') > -1 || isSSEDOM);
	if (this._request.connection.client.state & grappler.STATE.PROTO_WEBSOCKET) { // websockets
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

Buffer.prototype.indexOf = function(value) {
	var index = -1;
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
	for (var i=this.length-1; i>=0; --i) {
		if (this[i] == value) {
			index = i;
			break;
		}
	}
	return index;
};