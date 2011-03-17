require.paths.unshift(__dirname);
var url = require('url'),
    crypto = require('crypto'),
    EventEmitter = require('events').EventEmitter,
    util = require('util'),
    http = require('http'),
    common = require('common'),
    Message = common.Message;

require('../deps/cookie-node').secret = null;

function isAllowed(allowedOrigins, testOrigin) {
  return allowedOrigins.some(function(origin) {
    var originParts = url.parse(testOrigin);
    originParts.port = originParts.port || 80;
    return ( (origin[0] === '*' || origin[0] === originParts.hostname) &&
             (origin[1] === '*' || origin[1] == originParts.port) );
  });
}

function pack(num) {
  var result = '';
  result += String.fromCharCode(num >> 24 & 0xFF);
  result += String.fromCharCode(num >> 16 & 0xFF);
  result += String.fromCharCode(num >> 8 & 0xFF);
  result += String.fromCharCode(num & 0xFF);
  return result;
}

var HttpClient = function(req, res, upgradeBody) {
  var client = this.client = req.connection.client,
      self = this,
      server = client.server;
  this.server = server;
  this._req = req;
  this._res = res;
  this.remoteAddress = client.remoteAddress;
  this.state = client.state;

  // Ignore favicon requests since they weren't handled by the user's callback
  if (req.url === "/favicon.ico") {
    res.writeHead(404);
    res.end();
    return;
  }

  // Check for a permitted origin
  if (req.headers.origin && !isAllowed(server.options.origins, req.headers.origin)) {
    server.options.logger('HttpClient :: Denied client ' + client._id + ' due to disallowed origin (\'' + req.headers.origin + '\')', common.LOG.INFO);
    if (res instanceof http.ServerResponse) {
      res.writeHead(403);
      res.end();
    }
    req.connection.destroy();
    return;
  }

  if (req.headers.upgrade) {
    if (req.headers.upgrade === 'WebSocket')
      self.state |= common.STATE.PROTO_WEBSOCKET;
    else {
      self.disconnect();
      server.options.logger('HttpClient :: Unrecognized HTTP upgrade request: ' + req.headers.upgrade, common.LOG.WARN);
    }
  }

  // Check for a WebSocket request
  if (self.state & common.STATE.PROTO_WEBSOCKET) {
    self._makePerm();
    var draft = (typeof req.headers['sec-websocket-key1'] !== 'undefined' &&
                 typeof req.headers['sec-websocket-key2'] !== 'undefined' ? 76 : 75),
        outgoingdata = ['HTTP/1.1 101 Web' + (draft === 75 ? ' ' : '') + 'Socket Protocol Handshake', 
                        'Upgrade: WebSocket', 
                        'Connection: Upgrade'],
        beginMsg = true, curMsg;
    server.options.logger('HttpClient :: Using WebSocket draft ' + draft + ' for client id ' + client._id, common.LOG.INFO);

    if (draft === 75) {
      outgoingdata = outgoingdata.concat(['WebSocket-Origin: ' + req.headers.origin, 'WebSocket-Location: ws://' + req.headers.host + req.url]);
      outgoingdata = outgoingdata.concat(['', '']).join('\r\n');
    } else if (draft === 76) {
      var strkey1 = req.headers['sec-websocket-key1'],
        strkey2 = req.headers['sec-websocket-key2'],
        key1 = parseInt(strkey1.replace(/[^\d]/g, ""), 10),
        key2 = parseInt(strkey2.replace(/[^\d]/g, ""), 10),
        spaces1 = strkey1.replace(/[^\ ]/g, "").length,
        spaces2 = strkey2.replace(/[^\ ]/g, "").length;

      if (spaces1 === 0 || spaces2 === 0 || key1 % spaces1 !== 0 || key2 % spaces2 !== 0 && upgradeBody.length === 8) {
        server.options.logger('HttpClient :: WebSocket request contained an invalid key. Closing connection.', common.LOG.WARN);
        self.disconnect();
        return;
      }

      outgoingdata = outgoingdata.concat(['Sec-WebSocket-Origin: ' + req.headers.origin, 'Sec-WebSocket-Location: ws://' + req.headers.host + req.url]);
      if (req.headers['Sec-WebSocket-Protocol'])
        outgoingdata = outgoingdata.concat(['Sec-WebSocket-Protocol: ' + req.headers['Sec-WebSocket-Protocol']]);

      var hash = crypto.createHash('md5');
      hash.update(pack(parseInt(key1/spaces1)));
      hash.update(pack(parseInt(key2/spaces2)));
      hash.update(upgradeBody.toString('binary'));
      outgoingdata = outgoingdata.concat(['', '']).join('\r\n') + hash.digest('binary');
    }
    self._makePerm();

    req.connection.setNoDelay(true);
    req.connection.setKeepAlive(true, server.options.pingInterval);
    req.connection.write(outgoingdata, (draft === 75 ? 'ascii' : 'binary'));
    self.handshake = true;

    if (req.connection.readyState === 'open')
      server.emit('connection', this);

    req.connection.on('data', function(data) {
      var beginMarker = 0, endMarker = 255, idxEnd;

      while (true) {
        if (beginMsg) {
          beginMsg = false;
          var byebye = false;
          if (data[0] === endMarker && typeof data[1] !== undefined && data[1] === beginMarker) {
            server.options.logger('HttpClient :: WebSocket received closing handshake. Closing connection.', common.LOG.INFO);
            byebye = true;
          } else if (data[0] !== beginMarker) {
            server.options.logger('HttpClient :: WebSocket data incorrectly framed by UA. Closing connection.', common.LOG.WARN);
            byebye = true;
          }
          if (byebye) {
            self.disconnect();
            return;
          }
          curMsg = new Message();
          self.emit('message', curMsg);
          data = data.slice(1);
        }

        idxEnd = data.indexOf(endMarker);
        idxStart = data.indexOf(beginMarker);

        if (idxEnd > -1) {
          curMsg.emit('data', data.slice(0, idxEnd));
          curMsg.emit('end');
          beginMsg = true;
          if (idxEnd === data.length-1)
            break;
          data = data.slice(idxEnd+1);
        } else {
          curMsg.emit('data', data);
          break;
        }
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
          res.setSecureCookie('grappler', client._id);
          self._makePerm();
          server.options.logger('HttpClient :: Using multipart for client id ' + client._id, common.LOG.INFO);
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
          req.connection.on('timeout', function() {
            self.write("");
            req.connection.setTimeout(server.options.pingInterval);
          });
          server.emit('connection', this);
        } else if (isSSE) { // Server-Side Events
          res.setSecureCookie('grappler', client._id);
          self._makePerm();
          server.options.logger('HttpClient :: Using server-side events for client id ' + client._id, common.LOG.INFO);
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
          req.connection.on('timeout', function() {
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
            res.setSecureCookie('grappler', client._id);
            // Reset connection to make sure the session cookie is set
            self.write("");
          } else {
            var isSubsequent = false,
                conn = server.connections.get(cookie);
            if (!conn) {
              // Initial connection
              server.connections.set(cookie, this);
              conn = this;
              server.emit('connection', this);
              conn._checkQueue = function() {
                // Send any pending data sent to this long poll client
                if (conn._queue && conn._queue.length)
                  conn.write();
              };
            } else {
              // The original HttpClient just needs to reuse subsequent connections'
              // ServerRequest and ServerResponse objects so that we can still write
              // the client using the original HttpClient instance
              conn._req = self._req;
              conn._res = self._res;
              isSubsequent = true;
            }
            // Set a timeout to assume the client has permanently disconnected if they
            // do not reconnect after a certain period of time
            conn._req.connection.on('end', function() {
              if (conn.pollWaiting)
                clearTimeout(conn.pollWaiting);
              conn.pollWaiting = setTimeout(function() {
                if (conn._req.connection.readyState !== 'open') {
                  try {
                    conn.emit('end');
                    req.connection.end();
                    req.connection.destroy();
                    server.connections.delete(cookie);
                  } catch(e) {}
                }
              }, server.options.pingInterval);
            });
            server.options.logger('HttpClient :: Client prefers id of ' + cookie + ' instead of ' + client._id + (isSubsequent ? ' (subsequent)' : ''), common.LOG.INFO);
            server.options.logger('HttpClient :: Using long polling for client id ' + cookie, common.LOG.INFO);
          }
        }
      break;
      case "POST":
        var cookie;
        // Authenticate the validity of the "send message" request as best as we can
        if (!(cookie = req.getSecureCookie('grappler')) || typeof server.connections.get(cookie) === 'undefined' ||
          req.connection.remoteAddress !== server.connections.get(cookie).remoteAddress ||
          !(server.connections.get(cookie).state & common.STATE.PROTO_HTTP)) {
            server.options.logger('HttpClient :: Invalid POST request due to bad cookie: ' + (cookie ? cookie : '(cookie not set)'), common.LOG.WARN);
            self.disconnect();
            return;
        }
        var msg = new Message();
        self.emit('message', msg);
        req.on('data', function(data) {
          msg.emit('data', data);
        });
        req.on('end', function() {
          res.writeHead(200);
          res.end();
          self.disconnect();
          msg.emit('end');
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
util.inherits(HttpClient, EventEmitter);
module.exports = HttpClient;

HttpClient.prototype._makePerm = function() {
  var self = this;
  this.state = (this.state & ~common.STATE.TEMP);
  this.server.connections.set(this.client._id, this); // lazy add to connections list
  this._req.connection.on('drain', function() { self.emit('drain'); });
};

HttpClient.prototype.write = function(data, encoding) {
  var isMultipart = (this._req.headers.accept && this._req.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
    isSSEDOM = (this._req.headers.accept && this._req.headers.accept.indexOf('application/x-dom-event-stream') > -1),
    isSSE = ((this._req.headers.accept && this._req.headers.accept.indexOf('text/event-stream') > -1) || isSSEDOM),
    self = this,
    retVal = true;

  try {
    if (this.state & common.STATE.PROTO_WEBSOCKET) { // WebSocket
      if (data.length > 0) {
        if (!self.handshake) {
          process.nextTick(function() { self.write(data, encoding); });
          return;
        }
        this._req.connection.write('\x00', 'binary');
        this._req.connection.write(data, 'utf8');
        retVal = this._req.connection.write('\xff', 'binary');
      }
    } else if (isMultipart) { // multipart (x-mixed-replace)
      this._res.write("Content-Type: " + (data instanceof Buffer && (!encoding || encoding === 'binary') ? "application/octet-stream" : "text/plain") + "\nContent-Length: " + data.length + "\n\n");
      this._res.write(data, encoding);
      retVal = this._res.write("\n--grappler\n");
    } else if (isSSE) { // Server-Sent Events -- via JS or DOM
      if (isSSEDOM)
        this._res.write("Event: grappler-data\n");
      this._res.write("data: ");
      this._res.write(data, encoding);
      retVal = this._res.write("\n\n");
    } else if (typeof self._checkQueue !== 'undefined') { // long poll
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
      
      if (this._req.connection.readyState === 'open') {
        data = this._queue.shift();
        encoding = data[1];
        data = data[0];
        this._res.writeHead(200, {
          'Content-Type': (data instanceof Buffer && (!encoding || encoding === 'binary') ? "application/octet-stream" : "text/plain"),
          'Content-Length': data.length,
          'Connection': 'keep-alive',
          'Expires': 'Fri, 01 Jan 1990 00:00:00 GMT',
          'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
          'Pragma': 'no-cache'
        });
        this._res.end(data, encoding);
      }
      process.nextTick(function() { self._checkQueue(); });
      
    }
  } catch(e) {} // silently trap "stream is not writable" errors for now

  return retVal;
};

HttpClient.prototype.disconnect = function() {
  var isMultipart = (this._req.headers.accept && this._req.headers.accept.indexOf('multipart/x-mixed-replace') > -1),
    isSSEDOM = (this._req.headers.accept && this._req.headers.accept.indexOf('application/x-dom-event-stream') > -1),
    isSSE = ((this._req.headers.accept && this._req.headers.accept.indexOf('text/event-stream') > -1) || isSSEDOM);

  if (!(this.state & common.STATE.PROTO_WEBSOCKET) && !isMultipart && !isSSE) { // long poll
    // For when we disconnect without having previously sent anything.
    // Without this, the browser (Chrome at least) seems to try to auto re-connect once more?
    if (!this._res._header) {
      this._res.writeHead(200, { 'Connection': 'close' });
      this._res.end();
    }
  } else if (this.state & common.STATE.PROTO_WEBSOCKET) {
    // Send closing handshake
    var buffer = new Buffer(2);
    buffer[0] = 255;
    buffer[1] = 0;
    this.write(buffer);
  }

  try {
    this._req.connection.end();
    this._req.connection.destroy();
  } catch (e) {}

  if ((this.state & common.STATE.ACCEPTED) && !(this.state & common.STATE.TEMP))
    this.emit('end');

  if (this.server.connections.get(this.client._id) && ((this.state & common.STATE.PROTO_WEBSOCKET) || isMultipart || isSSE)) {
    // TODO: delete on nextTick() instead?
    this.server.connections.delete(this.client._id);
  }
};


// Handy-dandy Buffer methods
Buffer.prototype.indexOf = function(value) {
  var index = -1;
  value = (typeof value === 'number' ? value : String.charCodeAt(value[0]));
  for (var i=0,len=this.length; i<len; ++i) {
    if (this[i] === value) {
      index = i;
      break;
    }
  }
  return index;
};
Buffer.prototype.lastIndexOf = function(value) {
  var index = -1;
  value = (typeof value === 'number' ? value : String.charCodeAt(value[0]));
  for (var i=this.length-1; i>=0; --i) {
    if (this[i] === value) {
      index = i;
      break;
    }
  }
  return index;
};