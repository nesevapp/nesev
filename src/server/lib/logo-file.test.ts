import { describe, expect, test } from "bun:test";
import { sniffLogo, svgProblem } from "./logo-file";

const enc = (s: string) => new TextEncoder().encode(s);
const svg = (body: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attrs} viewBox="0 0 10 10">${body}</svg>`;

describe("sniffLogo", () => {
  test("type from the content, not the name or MIME type", () => {
    expect(sniffLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("png");
    expect(sniffLogo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffLogo(enc("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffLogo(enc(svg("")))).toBe("svg");
    expect(sniffLogo(enc(`﻿<?xml version="1.0"?>\n<!-- Generator: Illustrator -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n${svg("")}`))).toBe("svg");
    expect(sniffLogo(enc("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffLogo(enc("GIF89a"))).toBeNull();
    expect(sniffLogo(new Uint8Array())).toBeNull();
  });
});

describe("svgProblem", () => {
  test("plain logos from editors pass", () => {
    expect(svgProblem(svg('<path d="M0 0h10v10z" fill="#123"/><circle cx="5" cy="5" r="2"/>'))).toBeNull();
    expect(
      svgProblem(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!-- c -->\n${svg(
          '<defs><style>.a{fill:url(#g)}</style><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="10" height="10"/></clipPath></defs>' +
            '<title>Logo</title><g clip-path="url(#c)" style="fill: url( \'#g\' )"><text x="1" y="9">A &amp; B</text><use href="#c" xlink:href="#c"/></g>' +
            '<metadata><rdf:RDF><cc:Work rdf:about=""><dc:format>image/svg+xml</dc:format></cc:Work></rdf:RDF></metadata><sodipodi:namedview inkscape:zoom="1"/>' +
            '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>',
          ' xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
        )}`,
      ),
    ).toBeNull();
    expect(svgProblem(svg("<style><![CDATA[ .a { fill: red } ]]></style>"))).toBeNull();
  });

  test("scripts, handlers, javascript: and HTML are refused", () => {
    const bad = [
      svg("<script>alert(1)</script>"),
      svg("<SCRIPT>alert(1)</SCRIPT>"),
      svg("<svg:script>alert(1)</svg:script>"),
      svg("", ' onload="alert(1)"'),
      svg('<rect width="1" height="1" ONCLICK="x()"/>'),
      svg('<rect xlink:onclick="x()"/>'),
      svg('<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror=alert(1)></div></foreignObject>'),
      svg('<a href="javascript:alert(1)"><rect/></a>'),
      svg('<a xlink:href="&#106;avascript:alert(1)"><rect/></a>'),
      svg('<use href="jav&#x09;ascript:alert(1)"/>'),
      svg('<animate attributeName="href" to="javascript:alert(1)"/>'),
      svg('<set attributeName="onmouseover" to="alert(1)"/>'),
      svg('<iframe src="x"/>'),
      svg('<g xmlns="http://www.w3.org/1999/xhtml"><b>x</b></g>'),
      svg('<x:div xmlns:x="http://www.w3.org/1999/xhtml">x</x:div>'),
      svg('<evil:thing xmlns:evil="urn:x"/>'),
      svg("<unknownElement/>"),
      svg("<style><![CDATA[</style><script>alert(1)</script>]]></style>"),
      `<?xml-stylesheet type="text/xsl" href="evil.xsl"?>${svg("")}`,
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "&#60;script&#62;">]>${svg("&x;")}`,
      svg("<rect/><script/>"),
      "<html><body>no svg</body></html>",
      "<svg",
    ];
    for (const s of bad) expect([s, svgProblem(s)]).not.toEqual([s, null]);
  });

  test("references outside the file are refused", () => {
    expect(svgProblem(svg('<image href="https://tracker.example/x.png"/>'))).toBe("SVG verweist auf externe Dateien");
    expect(svgProblem(svg('<use href="other.svg#a"/>'))).toBe("SVG verweist auf externe Dateien");
    expect(svgProblem(svg('<rect style="fill:url(https://x/y)"/>'))).toBe("SVG verweist auf externe Dateien");
    expect(svgProblem(svg("<style>@import url(https://x/y.css);</style>"))).not.toBeNull();
    expect(svgProblem(svg('<image href="data:image/svg+xml;base64,PHN2Zz4="/>'))).not.toBeNull();
    expect(svgProblem(svg('<g xml:base="https://x/"><use href="#a"/></g>'))).not.toBeNull();
  });
});
