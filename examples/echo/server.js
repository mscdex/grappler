var fs = require('fs'),
    grappler = require('../../lib/grappler'),
    common = require('../../lib/common');

var localFiles = {},
    address = "",
    port = 8080;

// Load the demo page
try {
	localFiles['demo.htm'] = fs.readFileSync('demo.htm');
} catch (err) {
	console.log('An error occurred while reading \'demo.htm\': ' + err);
	process.exit(1);
}

// Load the minified javascript needed to add support for Flash WebSockets
try {
	localFiles['flashws.js'] = fs.readFileSync('flashws.js');
} catch (err) {
	console.log('An error occurred while reading \'flashws.js\': ' + err);
	process.exit(1);
}

// Load the javascript client helper
try {
	localFiles['transport.js'] = fs.readFileSync('transport.js');
} catch (err) {
	console.log('An error occurred while reading \'transport.js\': ' + err);
	process.exit(1);
}

// Load the Flash WebSocket file itself
try {
	localFiles['WebSocketMain.swf'] = fs.readFileSync('WebSocketMain.swf');
} catch (err) {
	console.log('An error occurred while reading \'WebSocketMain.swf\': ' + err);
	process.exit(1);
}

// Create a new instance of a grappler server
var echoServer = new grappler.Server({
	logger: function(msg, level) {
		if (level == common.LOG.INFO)
			msg = 'INFO: ' + msg;
		else if (level == common.LOG.WARN)
			msg = 'WARN: ' + msg;
		else
			msg = 'ERROR: ' + msg;
		console.error('DEBUG: ' + msg);
	}
}, function(req, res) { // HTTP override function that lets us decide to handle requests instead of grappler
	// We don't care to filter WebSocket connections (e.g. check validity of cookies, etc)
	if (req.headers.upgrade)
		return;

  var file = req.url.substr(1), type = 'application/octet-stream';
  if (localFiles[file]) {
    switch (file.substr(file.lastIndexOf('.')+1)) {
      case 'js':
        type = 'text/javascript';
      break;
      case 'swf':
        type = 'application/x-shockwave-flash';
      break;
      case 'htm':
      case 'html':
        type = 'text/html';
      break;
    }
    res.writeHead(200, {
      'Connection': 'close',
      'Content-Type': type,
      'Content-Length': localFiles[file].length
    });
    res.end(localFiles[file]);
  } else if (file.length) {
    res.writeHead(404, { 'Connection': 'close' });
    res.end();
  }
});

// Listen for an incoming connection
echoServer.on('connection', function(client) {
	var type;
	if (client.state & common.STATE.PROTO_WEBSOCKET)
		type = "WebSocket";
	else if (client.state & common.STATE.PROTO_HTTP)
		type = "HTTP";
	else
		type = "Unknown";

	console.log(type + ' client connected from ' + client.remoteAddress);

  client.on('message', function(msg) {
    var text = '';
    msg.on('data', function(data) {
      text += data;
    });
    msg.on('end', function() {
      console.log('Received the following message from a client @ ' + client.remoteAddress + ': ' + text);
      //client.write(text);
      echoServer.broadcast(text);
    });
  });
	client.on('end', function() {
		console.log(type + ' client disconnected from ' + client.remoteAddress);
	});
});

echoServer.listen(port);
console.log('Echo server started on port ' + port);