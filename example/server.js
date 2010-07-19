var sys = require('sys'),
	fs = require('fs'),
	grappler = require('../lib/grappler'),
	testPage, jsFlashWS, swf, address = "", port = 8080;

// Load the demo page
try {
	testPage = fs.readFileSync('test.htm');
} catch (err) {
	sys.puts('An error occurred while reading \'test.htm\': ' + err);
	process.exit(1);
}

// Load the minified javascript needed to add support for Flash WebSockets
try {
	jsFlashWS = fs.readFileSync('flashws.js');
} catch (err) {
	sys.puts('An error occurred while reading \'flashws.js\': ' + err);
	process.exit(1);
}

// Load the Flash WebSocket file itself
try {
	swf = fs.readFileSync('WebSocketMain.swf');
} catch (err) {
	sys.puts('An error occurred while reading \'WebSocketMain.swf\': ' + err);
	process.exit(1);
}

// Create a new instance of a grappler server
var echoServer = new grappler.Server({
	logger: function(msg, level) {
		if (level == grappler.LOG.INFO)
			msg = 'INFO: ' + msg;
		else if (level == grappler.LOG.WARN)
			msg = 'WARN: ' + msg;
		else
			msg = 'ERROR: ' + msg;
		sys.debug(msg);
	}
}, function(req, res) { // HTTP override function that lets us decide to handle requests instead of grappler
	// Lazily determine the server's reachable IP address and port
	if (address.length == 0) {
		address = req.headers.host;
		testPage = testPage.toString().replace(/__address__/g, address);
	}
	switch (req.url) {
		case "/test":
			res.writeHead(200, { 'Connection': 'close', 'Content-Type': 'text/html', 'Content-Length': testPage.length });
			res.end(testPage);
		break;
		case "/flashws.js":
			res.writeHead(200, { 'Connection': 'close', 'Content-Type': 'text/javascript', 'Content-Length': jsFlashWS.length });
			res.end(jsFlashWS);
		break;
		case "/WebSocketMain.swf":
			res.writeHead(200, { 'Connection': 'close', 'Content-Type': 'application/x-shockwave-flash', 'Content-Length': swf.length });
			res.end(swf);
		break;
		case "/favicon.ico":
			res.writeHead(404, { 'Connection': 'close' });
			res.end();
		break;
	}
});

// Listen for an incoming connection
echoServer.addListener('connection', function(client) {
	var type;
	if (client.state & grappler.STATE.PROTO_WEBSOCKET)
		type = "WebSocket";
	else if (client.state & grappler.STATE.PROTO_HTTP)
		type = "HTTP";
	else if (client.state & grappler.STATE.PROTO_TCP)
		type = "TCP";
	else
		type = "Unknown";

	sys.puts(type + ' client connected from ' + client.remoteAddress);

	client.addListener('data', function(buffer, from) {
		sys.puts('Received the following from client @ ' + from.remoteAddress + ': ' + buffer.toString());
	});
	client.addListener('close', function() {
		sys.puts(type + ' client disconnected from ' + client.remoteAddress);
	});
});
echoServer.addListener('data', function(buffer, client) {
	sys.puts('Received the following from client @ ' + client.remoteAddress + ': ' + buffer.toString());
	// Echo back to the user
	client.write(buffer);
});

echoServer.listen(port);
sys.puts('Echo server started on port ' + port + '.');