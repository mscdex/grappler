Grappler
========

Grappler is a minimalistic server for hanging ("comet") TCP/HTTP connections that exposes a single, consistent API across all transports.
It supports the following transports:

- WebSockets (with Flash policy support)
- XHR Long Polling
- XHR Multipart Streaming
- Server-Sent Events
- Plain TCP connections (Not yet implemented)

Requirements
============

- Tested with Node v0.1.100+
- A client supporting one of the aforementioned transports.
- For HTTP (non-WebSocket) clients, cookies must be enabled for clients ONLY if they are going to send messages (i.e. via POST) to the server.

Example
=======

Run example/server.js.
Visit the example server's test page in your browser: http://serverip:8080/test

API
===

TODO :-)