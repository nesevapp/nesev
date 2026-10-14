// Minimal text/event-stream parser (hc doesn't do SSE). Pure, so it is unit-testable without a DOM.
// Events are separated by a blank line; only `data:` lines are used (joined with "\n" when an event has several),
// `event:`, `id:` and comment lines (":") are ignored.

/** Incremental parser: feed decoded text chunks, get the complete events' data payloads. */
export function createSseParser() {
  let buffer = "";
  const parseBlock = (block: string): string | null => {
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    return data.length > 0 ? data.join("\n") : null;
  };
  return {
    /** Returns the data of every event completed by this chunk. */
    push(chunk: string): string[] {
      buffer += chunk.replace(/\r\n?/g, "\n");
      const out: string[] = [];
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const data = parseBlock(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data !== null) out.push(data);
      }
      return out;
    },
    /** Data of a trailing event without the final blank line (stream ended). */
    flush(): string[] {
      const data = buffer.trim() ? parseBlock(buffer) : null;
      buffer = "";
      return data !== null ? [data] : [];
    },
  };
}

/** Reads a fetch body as SSE and calls onData with each event's data payload. */
export async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const data of parser.push(decoder.decode(value, { stream: true }))) onData(data);
    }
    for (const data of parser.push(decoder.decode())) onData(data);
    for (const data of parser.flush()) onData(data);
  } finally {
    reader.releaseLock();
  }
}
