/**
 * Just enough XML to read a spreadsheet, and nothing that could be turned
 * against us.
 *
 * WHAT IT REFUSES, AND WHY THAT IS THE POINT
 *
 * A general XML parser resolves entities, and entity resolution is how XML
 * becomes a file-read primitive and a denial-of-service one. The two classic
 * shapes:
 *
 *   <!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>  reads our disk
 *   <!DOCTYPE x [<!ENTITY a "aaa..."><!ENTITY b "&a;&a;...">]>  the billion laughs
 *
 * Neither appears in a spreadsheet written by Excel, Google Sheets, LibreOffice
 * or any other tool a customer's insurer uses. So this refuses a DOCTYPE
 * outright rather than trying to parse one safely — the safest parser for a
 * construct you never need is the one that has no code for it.
 *
 * Only the five predefined entities are expanded, plus numeric character
 * references. An undefined entity is refused rather than passed through, because
 * passing `&foo;` into a question's text would put a fragment of somebody's
 * attempt into a document we later render back to them.
 *
 * SHAPE, NOT A TREE
 *
 * This is a pull parser over the two shapes needed — a flat list of `<si>`
 * strings, and rows of cells. It builds no document tree: a worksheet with
 * 50,000 rows should not become 50,000 objects to find one column.
 */

export class XmlRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'XmlRefusal';
  }
}

/** Bytes of XML text this parser will consider, as a last backstop. */
export const MAX_XML_BYTES = 100 * 1024 * 1024;

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Refuse the constructs that make XML dangerous, before parsing anything.
 *
 * Checked on the raw text rather than during the walk, so a malicious prologue
 * cannot be reached at all. The window is the head of the document because
 * that is where a prologue is legal; a `<!DOCTYPE` appearing later is not a
 * doctype, it is character data inside an element.
 */
export function assertSafeXml(text: string): void {
  if (text.length > MAX_XML_BYTES) {
    throw new XmlRefusal('This spreadsheet part is too large to parse.', 'TOO_LARGE');
  }

  const prologue = text.slice(0, 4096);
  if (/<!DOCTYPE/i.test(prologue)) {
    throw new XmlRefusal(
      'This spreadsheet declares an XML document type. Spreadsheets written by ordinary ' +
        'tools do not, and a document type is how XML is used to read files off a server. ' +
        'Refusing to parse it.',
      'DOCTYPE_REFUSED',
    );
  }
  if (/<!ENTITY/i.test(prologue)) {
    throw new XmlRefusal(
      'This spreadsheet defines custom XML entities. Refusing to parse it.',
      'ENTITY_REFUSED',
    );
  }
}

/** Expand character data. Refuses an entity it does not recognise. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw;

  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Surrogates and out-of-range values are how a reference becomes a way
      // to inject an unpaired code unit into a string we later store.
      if (!Number.isFinite(code) || code < 0x9 || code > 0x10ffff) {
        throw new XmlRefusal(
          `This spreadsheet contains the character reference "${match}", which is not a ` +
            'character. Refusing to parse it.',
          'BAD_CHARACTER_REFERENCE',
        );
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        throw new XmlRefusal(
          `This spreadsheet contains a surrogate character reference "${match}".`,
          'BAD_CHARACTER_REFERENCE',
        );
      }
      return String.fromCodePoint(code);
    }

    const expansion = PREDEFINED_ENTITIES[body];
    if (expansion === undefined) {
      throw new XmlRefusal(
        `This spreadsheet references the XML entity "&${body};", which is not one of the five ` +
          'predefined entities. Refusing to parse it rather than passing it through.',
        'UNKNOWN_ENTITY',
      );
    }
    return expansion;
  });
}

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** True for `<x/>`, which has no closing tag and therefore no text. */
  readonly selfClosing: boolean;
}

/**
 * Walk elements in document order, calling back on each open tag.
 *
 * `textUntilClose` is provided rather than the text being passed eagerly: for a
 * worksheet the walker sees millions of `<c>` and `<v>` opens and only a few
 * matter, so decoding every one's text would be most of the cost of the parse.
 */
export function walkXml(
  text: string,
  visit: (element: XmlElement, textUntilClose: () => string) => void,
): void {
  assertSafeXml(text);

  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open === -1) break;

    // Comments, processing instructions and CDATA are skipped rather than
    // interpreted. None carries a cell value.
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open);
      index = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open);
      index = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('</', open)) {
      const close = text.indexOf('>', open);
      index = close === -1 ? text.length : close + 1;
      continue;
    }

    const close = text.indexOf('>', open);
    if (close === -1) break;

    const inner = text.slice(open + 1, close);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;

    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    const attributes: Record<string, string> = {};

    if (space !== -1) {
      const attributeText = body.slice(space);
      const pattern = /([:\w.-]+)\s*=\s*"([^"]*)"|([:\w.-]+)\s*=\s*'([^']*)'/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(attributeText)) !== null) {
        const key = match[1] ?? match[3];
        const value = match[2] ?? match[4];
        if (key !== undefined && value !== undefined) attributes[key] = decodeXmlText(value);
      }
    }

    const afterOpen = close + 1;
    const textUntilClose = (): string => {
      if (selfClosing) return '';
      const closing = text.indexOf(`</${name}`, afterOpen);
      if (closing === -1) return '';
      return decodeXmlText(text.slice(afterOpen, closing));
    };

    visit({ name, attributes, selfClosing }, textUntilClose);
    index = afterOpen;
  }
}

/**
 * Concatenated text of every descendant, for an element whose content is split
 * across runs.
 *
 * A shared string with mixed formatting arrives as several `<t>` runs inside
 * `<r>` wrappers rather than one `<t>`. Reading only the first run truncates a
 * question at its first bold word, which is exactly the kind of silent data
 * loss that produces a confidently wrong answer.
 */
export function allTextWithin(fragment: string): string {
  let out = '';
  const pattern = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    if (match[1] !== undefined) out += decodeXmlText(match[1]);
  }
  return out;
}
