#!/usr/bin/env python3
"""Server HTTP locale leggero per aprire le videolezioni nel browser."""

import argparse
import functools
import http.server
import socketserver
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class CleanHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description="Avvia il server locale per videolezioni/.")
    parser.add_argument("--port", type=int, default=8080, help="Porta HTTP (default: 8080)")
    args = parser.parse_args()

    handler = functools.partial(CleanHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Videolezioni attive su http://127.0.0.1:{args.port}/")
        print("Premi Ctrl+C per fermare.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer fermato.")


if __name__ == "__main__":
    main()
