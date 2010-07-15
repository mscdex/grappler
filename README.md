Grappler
========

Grappler is a minimalistic server for hanging TCP/HTTP connections. It supports the following transports:

- WebSockets (with Flash policy support)
- XHR Long Polling
- XHR Multipart Streaming
- Server-Sent Events
- Plain TCP connections

Requirements
------------

- Tested with Node v0.1.100+
- A client supporting one of the aforementioned transports.
- For HTTP (not websocket) clients, cookies must be enabled.

Notes
-----

Grappler is currently very much a WIP.