import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TemplateCreate, TemplateUpdate } from "@shared/schemas/template";
import { api, parseResponse } from "@/lib/api";

// Other features may import templatesQuery (e.g. the template picker on documents).
export const templatesQuery = queryOptions({
  queryKey: ["templates", "list"],
  queryFn: () => parseResponse(api.templates.$get()),
});

export type TemplateSummary = Awaited<ReturnType<NonNullable<typeof templatesQuery.queryFn>>>[number];

export const templateQuery = (id: number) =>
  queryOptions({
    queryKey: ["templates", "detail", id],
    queryFn: () => parseResponse(api.templates[":id"].$get({ param: { id: String(id) } })),
  });

export const templateSampleQuery = (id: number) =>
  queryOptions({
    queryKey: ["templates", "sample", id],
    queryFn: () => parseResponse(api.templates[":id"]["sample-input"].$get({ param: { id: String(id) } })),
    staleTime: 0,
  });

function useInvalidateTemplates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["templates"] });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (json: TemplateCreate) => parseResponse(api.templates.$post({ json })),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateTemplate(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (json: TemplateUpdate) => parseResponse(api.templates[":id"].$put({ param: { id: String(id) }, json })),
    onSuccess: (saved) => {
      qc.setQueryData(templateQuery(id).queryKey, saved);
      return qc.invalidateQueries({ queryKey: ["templates", "list"] });
    },
  });
}

export function useSetDefaultTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.templates[":id"].default.$post({ param: { id: String(id) } })),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateTemplates();
  return useMutation({
    mutationFn: (id: number) => parseResponse(api.templates[":id"].$delete({ param: { id: String(id) } })),
    onSuccess: () => invalidate(),
  });
}

export function useUploadBasePdf(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      parseResponse(api.templates[":id"]["base-pdf"].$post({ param: { id: String(id) }, form: { file } })),
    onSuccess: (saved) => {
      qc.setQueryData(templateQuery(id).queryKey, saved);
      return qc.invalidateQueries({ queryKey: ["templates", "list"] });
    },
  });
}

export function useRemoveBasePdf(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => parseResponse(api.templates[":id"]["base-pdf"].$delete({ param: { id: String(id) } })),
    onSuccess: (saved) => {
      qc.setQueryData(templateQuery(id).queryKey, saved);
      return qc.invalidateQueries({ queryKey: ["templates", "list"] });
    },
  });
}
