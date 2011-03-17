var sys = require('sys'),
    net = require('net'),
    grappler = require('../../lib/grappler'),
    connect = require('connect');

var connect_server = connect.createServer();

connect_server.use('/',
    function(req, resp, next) {
        if( resp instanceof net.Stream ) {
            return;
        }
        next();
    },
    connect.staticProvider()
);


var server = new grappler.Server({
    logger: function(msg, level) {
        if (level == grappler.LOG.INFO)
            msg = 'INFO: ' + msg;
        else if (level == grappler.LOG.WARN)
            msg = 'WARN: ' + msg;
        else
            msg = 'ERROR: ' + msg;
        sys.debug(msg);
    }
}, function(req, resp) {
    connect_server.handle(req, resp, function() {});
});

server.listen(3001);