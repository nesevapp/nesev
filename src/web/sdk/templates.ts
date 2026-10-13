import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TemplateCreate, TemplateUpdate } from "@shared/schemas/template";
import { idParam, parseResponse, templates } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

export const templatesApi = {
  list: () => parseResponse(templates.index.$get()),
  get: (id: number) => parseResponse(templates[":id"].$get({ param: idParam(id) })),
  /** Sample input (a real or dummy document) for the designer preview. */
  sampleInput: (id: number) => parseResponse(templates[":id"]["sample-input"].$get({ param: idParam(id) })),
  create: (json: TemplateCreateInput) => parseResponse(templates.index.$post({ json })),
  update: (id: number, json: TemplateUpdateInput) => parseResponse(templates[":id"].$put({ param: idParam(id), json })),
  setDefault: (id: number) => parseResponse(templates[":id"].default.$post({ param: idParam(id) })),
  remove: (id: number) => parseResponse(templates[":id"].$delete({ param: idParam(id) })),
  uploadBasePdf: (id: number, file: File) =>
    parseResponse(templates[":id"]["base-pdf"].$post({ param: idParam(id), form: { file } })),
  removeBasePdf: (id: number) => parseResponse(templates[":id"]["base-pdf"].$delete({ param: idParam(id) })),
};

export type Template = Awaited<ReturnType<typeof templatesApi.get>>;
export type TemplateListItem = Awaited<ReturnType<typeof templatesApi.list>>[number];
export type TemplateCreateInput = TemplateCreate;
export type TemplateUpdateInput = TemplateUpdate;

// Other features use templatesQuery too (e.g. the template picker on documents).
export const templatesQuery = queryOptions({
  queryKey: keys.templates.list,
  queryFn: templatesApi.list,
});

export const templateQuery = (id: number) =>
  queryOptions({
    queryKey: keys.templates.detail(id),
    queryFn: () => templatesApi.get(id),
  });

export const templateSampleQuery = (id: number) =>
  queryOptions({
    queryKey: keys.templates.sample(id),
    queryFn: () => templatesApi.sampleInput(id),
    staleTime: 0,
  });

/** Write the saved template into its detail cache and refresh the list. */
function useOnSaved(id: number) {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  return (saved: Template) => {
    qc.setQueryData(templateQuery(id).queryKey, saved);
    return invalidate("templateSaved");
  };
}

export function useCreateTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: TemplateCreateInput) => templatesApi.create(json),
    onSuccess: () => invalidate("templates"),
  });
}

export function useUpdateTemplate(id: number) {
  const onSaved = useOnSaved(id);
  return useMutation({
    mutationFn: (json: TemplateUpdateInput) => templatesApi.update(id, json),
    onSuccess: onSaved,
  });
}

export function useSetDefaultTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => templatesApi.setDefault(id),
    onSuccess: () => invalidate("templates"),
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => templatesApi.remove(id),
    onSuccess: () => invalidate("templates"),
  });
}

export function useUploadBasePdf(id: number) {
  const onSaved = useOnSaved(id);
  return useMutation({
    mutationFn: (file: File) => templatesApi.uploadBasePdf(id, file),
    onSuccess: onSaved,
  });
}

export function useRemoveBasePdf(id: number) {
  const onSaved = useOnSaved(id);
  return useMutation({
    mutationFn: () => templatesApi.removeBasePdf(id),
    onSuccess: onSaved,
  });
}
