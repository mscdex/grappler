var sys=require('sys'), grappler=require('../lib/grappler');

var server = new grappler.Server({
	logger: function(msg, level) {
		sys.debug(msg);
	}
}, function(req, res) {
	if (req.url.indexOf("/favicon.ico") == 0) {
		res.writeHead(404);
		res.end();
	} else if (req.url.indexOf("/site") == 0) {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('Handling /site/* from the grappler HTTP handler callback!');
	}
});

server.addListener('connection', function(client) {
	var type;
	if (client.state & grappler.STATE.PROTO_WEBSOCKET)
		type = "WebSocket";
	else if (client.state & grappler.STATE.PROTO_HTTP)
		type = "HTTP";
	else if (client.state & grappler.STATE.PROTO_TCP)
		type = "TCP";
	else
		type = "Unknown";
	sys.puts(type + ' client connected from ' + client.socket.remoteAddress);
	client.addListener('data', function(buffer) {
		sys.puts('Received the following from ' + type + ' client @ ' + client.socket.remoteAddress + ': ' + buffer.toString());
	});
	client.addListener('disconnect', function() {
		sys.puts(type + ' client disconnected from ' + client.socket.remoteAddress);
	});
	if (type == "HTTP") { // test non-websocket connection (long poll, etc)
		setTimeout(function() {
			client.write('Hello from grappler!');
			client.disconnect();
		}, 5000);
	}
});

server.listen(8080);
sys.puts('Server started.');