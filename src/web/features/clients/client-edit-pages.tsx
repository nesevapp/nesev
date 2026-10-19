import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { apiErrorMessage, clientQuery, useCreateClient, useUpdateClient } from "@/sdk";
import { ClientForm, clientToFormValues, EMPTY_CLIENT } from "./components/client-form";

export function NewClientPage() {
  const create = useCreateClient();
  const navigate = useNavigate();
  const router = useRouter();

  return (
    <Page title={<Breadcrumb current="Neuer Kunde" />}>
      <ClientForm
        defaultValues={EMPTY_CLIENT}
        pending={create.isPending}
        submitLabel="Kunde anlegen"
        onCancel={() => router.history.back()}
        onSubmit={async (values) => {
          const c = await create.mutateAsync(values).catch((err: unknown) => {
            toast.error(apiErrorMessage(err));
            throw err;
          });
          toast.success("Kunde angelegt");
          void navigate({ to: "/clients/$id", params: { id: c.id } });
        }}
      />
    </Page>
  );
}

const editRoute = getRouteApi("/clients/$id/edit");

export function EditClientPage() {
  const { id } = editRoute.useParams();
  const { data: client } = useSuspenseQuery(clientQuery(id));
  const update = useUpdateClient(id);
  const navigate = useNavigate();
  const toDetail = () => navigate({ to: "/clients/$id", params: { id } });

  return (
    <Page title={<Breadcrumb current={`${client.name} bearbeiten`} />}>
      <ClientForm
        defaultValues={clientToFormValues(client)}
        pending={update.isPending}
        submitLabel="Speichern"
        onCancel={toDetail}
        onSubmit={async (values) => {
          await update.mutateAsync(values).catch((err: unknown) => {
            toast.error(apiErrorMessage(err));
            throw err;
          });
          toast.success("Kunde gespeichert");
          void toDetail();
        }}
      />
    </Page>
  );
}

function Breadcrumb({ current }: { current: string }) {
  return (
    <span className="flex items-center gap-2">
      <Link to="/clients" className="font-normal text-muted-foreground hover:text-foreground">
        Kunden
      </Link>
      <span className="font-normal text-muted-foreground/50">/</span>
      <span>{current}</span>
    </span>
  );
}
