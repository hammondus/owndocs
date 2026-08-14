package main

import (
	"encoding/xml"
	"io"
	"os"
	"strings"
	"testing"
)

// The favicon shipped as a hand-written SVG, and was broken for a day without
// anything noticing: the comment explaining where its colours come from named
// the CSS custom properties `- -signal` and `- -ink` (spelled here with a space
// for the same reason the file itself avoids them), and an XML comment may not
// contain a double hyphen. SVG is parsed as strict XML, so the file failed to
// parse — while still building, still being served with the right MIME type,
// and still returning 200. Every signal a person would think to check looked
// healthy, and the icon simply never appeared.
//
// So this parses it the way a browser does. It reads the tracked source rather
// than the build output, which is absent on a fresh clone before `make js`.
const faviconPath = "web/public/favicon.svg"

func TestFaviconIsWellFormedXML(t *testing.T) {
	f, err := os.Open(faviconPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	dec := xml.NewDecoder(f)
	for {
		_, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			// The double-hyphen case is worth naming, because the error alone
			// sends you looking at the markup rather than at a comment.
			t.Fatalf("%s is not well-formed XML, so no browser will render it: %v\n"+
				"If this mentions a double hyphen, a comment contains one — most likely a CSS "+
				"custom property written the way CSS spells it.", faviconPath, err)
		}
	}
}

// A favicon has to be rasterised into a fixed pixel box. An SVG carrying only a
// viewBox has no intrinsic size, which some consumers handle and others do not;
// stating both costs two attributes and removes the question.
func TestFaviconHasIntrinsicSize(t *testing.T) {
	b, err := os.ReadFile(faviconPath)
	if err != nil {
		t.Fatal(err)
	}
	var svg struct {
		Width   string `xml:"width,attr"`
		Height  string `xml:"height,attr"`
		ViewBox string `xml:"viewBox,attr"`
	}
	if err := xml.Unmarshal(b, &svg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if svg.Width == "" || svg.Height == "" {
		t.Errorf("favicon has no width/height, so it has no intrinsic size (viewBox=%q)", svg.ViewBox)
	}
	if svg.ViewBox == "" {
		t.Error("favicon has no viewBox, so it cannot scale")
	}
}

// The index page has to actually point at it. The file being correct and the
// page not referencing it look identical from the outside: no icon.
func TestIndexReferencesTheFavicon(t *testing.T) {
	b, err := os.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	html := string(b)
	if !strings.Contains(html, `rel="icon"`) {
		t.Error("web/index.html declares no icon")
	}
	if !strings.Contains(html, "/favicon.svg") {
		t.Error("web/index.html does not point at /favicon.svg")
	}
}
