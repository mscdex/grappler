var sys=require('sys'), grappler=require('../lib/grappler');

var server = new grappler.Server({
	logger: function(msg, level) {
		sys.debug(msg);
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
});

server.listen(8080);
sys.puts('Server started.');