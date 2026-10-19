import { useState, type ReactNode } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { countryName } from "@shared/countries";
import { formatClientNumber } from "@shared/schemas/client";
import { defaultTaxMode, TAX_MODE_LABELS } from "@shared/tax";
import { Page } from "@/components/page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  apiErrorMessage,
  type Client,
  clientQuery,
  documentsQuery,
  settingsQuery,
  useDeleteClient,
  useSetClientArchived,
} from "@/sdk";
import { ClientDocuments } from "./components/client-documents";

const route = getRouteApi("/clients/$id");

export function ClientPage() {
  const { id } = route.useParams();
  const { data: client } = useSuspenseQuery(clientQuery(id));
  const archive = useSetClientArchived(id);

  const toggleArchived = () =>
    archive.mutate(!client.archivedAt, {
      onSuccess: (c) => toast.success(c.archivedAt ? "Kunde archiviert" : "Kunde wiederhergestellt"),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <Page
      title={
        <span className="flex items-center gap-2">
          <Link to="/clients" className="font-normal text-muted-foreground hover:text-foreground">
            Kunden
          </Link>
          <span className="font-normal text-muted-foreground/50">/</span>
          <span>{client.name}</span>
        </span>
      }
      description={
        <span className="flex items-center gap-2">
          <span className="tabular">{formatClientNumber(client.number)}</span>
          <span>·</span>
          <span>{client.type === "company" ? "Firma" : "Privatperson"}</span>
          {client.archivedAt && (
            <Badge variant="secondary" className="font-normal">
              Archiviert
            </Badge>
          )}
        </span>
      }
      actions={
        <>
          <Button asChild variant="outline" size="sm">
            <Link to="/clients/$id/edit" params={{ id }}>
              <Pencil />
              Bearbeiten
            </Link>
          </Button>
          <ClientActions client={client} onToggleArchived={toggleArchived} />
        </>
      }
    >
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-3">
        <InfoBlock title="Adresse">
          <AddressLines client={client} />
        </InfoBlock>
        <InfoBlock title="Kontakt">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {client.type === "company" && <Row label="Ansprechpartner:in" value={client.contactPerson} />}
            <Row
              label="E-Mail"
              value={client.email && <a href={`mailto:${client.email}`} className="hover:underline">{client.email}</a>}
            />
            <Row label="Telefon" value={client.phone && <a href={`tel:${client.phone}`} className="hover:underline">{client.phone}</a>} />
          </dl>
        </InfoBlock>
        <InfoBlock title="Steuer & Zahlung">
          <Conditions client={client} />
        </InfoBlock>
      </div>

      {client.notes && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-medium">Notizen</h2>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{client.notes}</p>
        </section>
      )}

      <section className="mt-8">
        <ClientDocuments clientId={client.id} />
      </section>
    </Page>
  );
}

function ClientActions({ client, onToggleArchived }: { client: Client; onToggleArchived: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useDeleteClient(client.id);
  const navigate = useNavigate();
  // same query as the "Dokumente" list below (cached); clients with documents can only be archived
  const { data: docs } = useQuery(documentsQuery({ clientId: client.id }));
  const docCount = docs?.length ?? 0;

  const onDelete = () =>
    del.mutate(undefined, {
      onSuccess: () => {
        toast.success("Kunde gelöscht");
        navigate({ to: "/clients" });
      },
      onError: (err) => {
        setConfirmDelete(false);
        toast.error(apiErrorMessage(err));
      },
    });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon-sm" aria-label="Weitere Aktionen">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onToggleArchived}>
            {client.archivedAt ? <ArchiveRestore /> : <Archive />}
            {client.archivedAt ? "Wiederherstellen" : "Archivieren"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
            <Trash2 />
            Löschen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          {docCount > 0 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Kunde kann nicht gelöscht werden</AlertDialogTitle>
                <AlertDialogDescription>
                  „{client.name}“ wird in {docCount === 1 ? "einem Beleg" : `${docCount} Belegen`} verwendet. Belege
                  müssen erhalten bleiben, deshalb kann der Kunde nur archiviert werden: Er verschwindet dann aus der
                  Kundenauswahl, seine Belege bleiben unverändert.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{client.archivedAt ? "Schließen" : "Abbrechen"}</AlertDialogCancel>
                {!client.archivedAt && (
                  <AlertDialogAction onClick={onToggleArchived}>
                    <Archive />
                    Archivieren
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Kunde löschen?</AlertDialogTitle>
                <AlertDialogDescription>„{client.name}“ wird endgültig gelöscht.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={del.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    onDelete();
                  }}
                >
                  Löschen
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function InfoBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-background p-5">
      <h2 className="mb-3 text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h2>
      <div className="text-sm">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value || <span className="text-muted-foreground/60">–</span>}</dd>
    </>
  );
}

function AddressLines({ client }: { client: Client }) {
  const lines = [
    client.name,
    client.type === "company" && client.contactPerson ? `z. Hd. ${client.contactPerson}` : "",
    client.street,
    client.addressExtra,
    [client.zip, client.city].filter(Boolean).join(" "),
    countryName(client.country),
  ].filter(Boolean);
  return (
    <address className="leading-relaxed not-italic">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </address>
  );
}

function Conditions({ client }: { client: Client }) {
  const settings = useQuery(settingsQuery);
  const derived = defaultTaxMode({ ...client, defaultTaxMode: null }, { smallBusiness: settings.data?.smallBusiness ?? false, uid: settings.data?.uid });
  const taxMode = client.defaultTaxMode ? (
    TAX_MODE_LABELS[client.defaultTaxMode]
  ) : (
    <>
      {TAX_MODE_LABELS[derived]} <span className="text-muted-foreground">(automatisch)</span>
    </>
  );
  const terms =
    client.paymentTermsDays !== null ? (
      `${client.paymentTermsDays} Tage`
    ) : settings.data ? (
      <>
        {settings.data.paymentTermsDays} Tage <span className="text-muted-foreground">(Standard)</span>
      </>
    ) : (
      "Standard"
    );

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      <Row label="UID" value={client.uid} />
      <Row label="Steuermodus" value={taxMode} />
      <Row label="Zahlungsziel" value={terms} />
      {settings.data?.smallBusiness && (
        <p className="col-span-2 text-xs text-muted-foreground">Kleinunternehmerregelung aktiv: Inlandsbelege ohne USt.</p>
      )}
    </dl>
  );
}
