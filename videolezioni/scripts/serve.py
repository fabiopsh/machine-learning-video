#!/usr/bin/env python3
"""Server HTTP locale leggero con supporto HTTP Range (206) per seeking audio fluido."""

import argparse
import functools
import http.server
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")


class RangeHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
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
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.exists(path):
            return super().send_head()

        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        m = RANGE_RE.match(range_header.strip())
        if not m:
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            fs = os.fstat(f.fileno())
            size = fs.st_size
            start_s, end_s = m.group(1), m.group(2)

            if start_s == "" and end_s == "":
                f.close()
                return super().send_head()

            if start_s == "":
                # Suffix byte range: bytes=-500
                suffix = int(end_s)
                start = max(0, size - suffix)
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1

            if start >= size or start > end:
                f.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None

            end = min(end, size - 1)
            length = end - start + 1

            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()

            f.seek(start)
            self._range_remaining = length
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._range_remaining = None
        bufsize = 64 * 1024
        while remaining > 0:
            chunk = source.read(min(bufsize, remaining))
            if not chunk:
                break
            try:
                outputfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                break
            remaining -= len(chunk)

    def log_message(self, format, *args):
        # Suppress noisy broken-pipe/range logs while keeping startup clean
        pass


def main():
    parser = argparse.ArgumentParser(description="Avvia il server locale per videolezioni/.")
    parser.add_argument("--port", type=int, default=8080, help="Porta HTTP (default: 8080)")
    parser.add_argument("--dir", default=str(ROOT), help="Cartella radice da servire (default: videolezioni/)")
    args = parser.parse_args()

    serve_dir = str(Path(args.dir).resolve())
    handler = functools.partial(RangeHTTPRequestHandler, directory=serve_dir)
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Videolezioni attive su http://127.0.0.1:{args.port}/ ({serve_dir}, Range 206 enabled)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer fermato.")


if __name__ == "__main__":
    main()
