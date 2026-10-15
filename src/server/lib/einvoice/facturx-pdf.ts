import { AFRelationship, PDFDocument, PDFHexString, PDFName } from "@pdfme/pdf-lib";
import { escapeXml } from "./xml";
import { FACTURX_CONFORMANCE_LEVEL } from "./cii";

// Post-processing for ZUGFeRD / Factur-X: embeds the CII XML into a copy of the invoice PDF as
// "factur-x.xml" (AFRelationship Alternative, listed in the catalog's /AF) and adds what Factur-X
// expects around it: XMP metadata with the PDF/A-3 identification and the Factur-X extension schema,
// an sRGB output intent and a document ID. The stored, frozen PDF is never changed.
//
// PDF/A-3b is not checked at runtime. Verified once with veraPDF 1.30 and Mustang 2.26 (PDF/A-3b +
// Factur-X EN 16931 schematron: valid) for the default templates, with and without a transparent PNG
// logo; pdfme embeds full TrueType fonts. A custom letterhead PDF (pdf_templates.basePdfPath) is copied
// in as is and may break PDF/A, so the UI says "PDF/A-3 nicht garantiert" for those.

export const FACTURX_FILE_NAME = "factur-x.xml";

/** sRGB v2 "micro" ICC profile, 456 bytes, CC0 (github.com/saucecontrol/Compact-ICC-Profiles). */
const SRGB_ICC_BASE64 =
  "AAAByGxjbXMCEAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5knZEAPUCAsD1AdCyBnqUijgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAABfY3BydAAAAQwAAAAMd3RwdAAAARgAAAAUclhZWgAAASwAAAAUZ1hZWgAAAUAAAAAUYlhZWgAAAVQAAAAUclRSQwAAAWgAAABgZ1RSQwAAAWgAAABgYlRSQwAAAWgAAABgZGVzYwAAAAAAAAAFdVJHQgAAAAAAAAAAAAAAAHRleHQAAAAAQ0MwAFhZWiAAAAAAAADzVAABAAAAARbJWFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAkoAAAD4UAALbEY3VydgAAAAAAAAAqAAAAfAD4AZwCdQODBMkGTggSChgMYg70Ec8U9hhqHC4gQySsKWoufjPrObM/1kZXTTZUdlwXZB1shnVWfo2ILJI2nKunjLLbvpnKx9dl5Hfx+f//";

export interface FacturXOptions {
  /** "INVOICE" (also used for credit notes, as the Factur-X spec says) */
  documentType?: "INVOICE";
  conformanceLevel?: string;
  /** fixed timestamp for reproducible output (tests); defaults to now */
  now?: Date;
}

/** XMP date: 2026-03-31T10:00:00Z */
const xmpDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function xmpPacket(meta: { title: string; author: string; created: Date; modified: Date; conformanceLevel: string }): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.title)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${escapeXml(meta.author)}</rdf:li></rdf:Seq></dc:creator>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>nesev</xmp:CreatorTool>
      <xmp:CreateDate>${xmpDate(meta.created)}</xmp:CreateDate>
      <xmp:ModifyDate>${xmpDate(meta.modified)}</xmp:ModifyDate>
      <xmp:MetadataDate>${xmpDate(meta.modified)}</xmp:MetadataDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>nesev</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${FACTURX_FILE_NAME}</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${escapeXml(meta.conformanceLevel)}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentFileName</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The name of the embedded XML document</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>DocumentType</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The type of the hybrid document in capital letters, e.g. INVOICE or ORDER</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>Version</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The actual version of the standard applying to the embedded XML document</pdfaProperty:description>
                </rdf:li>
                <rdf:li rdf:parseType="Resource">
                  <pdfaProperty:name>ConformanceLevel</pdfaProperty:name>
                  <pdfaProperty:valueType>Text</pdfaProperty:valueType>
                  <pdfaProperty:category>external</pdfaProperty:category>
                  <pdfaProperty:description>The conformance level of the embedded XML document</pdfaProperty:description>
                </rdf:li>
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** A copy of `pdfBytes` with the Factur-X XML embedded. */
export async function embedFacturX(pdfBytes: Uint8Array, xml: string, options: FacturXOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const now = options.now ?? new Date();
  const created = doc.getCreationDate() ?? now;
  const title = doc.getTitle() ?? "";
  const author = doc.getAuthor() ?? "";

  await doc.attach(new TextEncoder().encode(xml), FACTURX_FILE_NAME, {
    mimeType: "text/xml",
    description: "Factur-X/ZUGFeRD Rechnung",
    creationDate: now,
    modificationDate: now,
    afRelationship: AFRelationship.Alternative,
  });

  // Info dictionary and XMP must agree (PDF/A)
  doc.setTitle(title);
  doc.setAuthor(author);
  doc.setCreator("nesev");
  doc.setProducer("nesev");
  doc.setCreationDate(created);
  doc.setModificationDate(now);

  const ctx = doc.context;
  const xmp = ctx.stream(
    new TextEncoder().encode(
      xmpPacket({ title, author, created, modified: now, conformanceLevel: options.conformanceLevel ?? FACTURX_CONFORMANCE_LEVEL }),
    ),
    { Type: "Metadata", Subtype: "XML" },
  );
  doc.catalog.set(PDFName.of("Metadata"), ctx.register(xmp));

  const icc = ctx.stream(Uint8Array.from(atob(SRGB_ICC_BASE64), (ch) => ch.charCodeAt(0)), { N: 3 });
  const intent = ctx.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFHexString.fromText("sRGB"),
    Info: PDFHexString.fromText("sRGB IEC61966-2.1"),
    DestOutputProfile: ctx.register(icc),
  });
  doc.catalog.set(PDFName.of("OutputIntents"), ctx.obj([ctx.register(intent)]));

  // stable file identifier derived from the content
  const digest = new Bun.CryptoHasher("md5").update(pdfBytes).update(xml).digest("hex");
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(digest), PDFHexString.of(digest)]);

  // classic xref table without object streams: the widest reader support for the attachment
  return doc.save({ updateFieldAppearances: false, useObjectStreams: false });
}
