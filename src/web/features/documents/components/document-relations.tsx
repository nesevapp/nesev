import { Link } from "@tanstack/react-router";
import { DOCUMENT_TYPE_LABELS } from "@shared/documents";
import { type Document } from "@/sdk";
import { docLink } from "../config";

type Ref = Document["children"][number];

function RefLink({ doc }: { doc: Ref }) {
  return (
    <Link {...docLink(doc.type, doc.id)} className="text-foreground underline-offset-4 hover:underline">
      {DOCUMENT_TYPE_LABELS[doc.type]} {doc.number ?? "(Entwurf)"}
    </Link>
  );
}

/** "Aus Angebot AN-2026-0001 · Rechnung RE-2026-0004" — the offer → invoice → credit note chain. */
export function DocumentRelations({ doc }: { doc: Document }) {
  if (!doc.parent && doc.children.length === 0 && !doc.recurringInvoiceId) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-1.5">
      {doc.recurringInvoiceId && (
        <span>
          Aus{" "}
          <Link
            to="/recurring/$id"
            params={{ id: doc.recurringInvoiceId }}
            className="text-foreground underline-offset-4 hover:underline"
          >
            Serienrechnung
          </Link>
        </span>
      )}
      {doc.recurringInvoiceId && (doc.parent || doc.children.length > 0) && <span aria-hidden>·</span>}
      {doc.parent && (
        <span>
          Erstellt aus <RefLink doc={doc.parent} />
        </span>
      )}
      {doc.parent && doc.children.length > 0 && <span aria-hidden>·</span>}
      {doc.children.length > 0 && (
        <span>
          Folgebelege:{" "}
          {doc.children.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ", "}
              <RefLink doc={c} />
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
