import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatBp, formatCents } from "@shared/money";
import { formatArticleNumber } from "@shared/schemas/article";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import { type ArticleDTO, articlePickerQuery } from "../api";

/**
 * Text input with article suggestions (free text stays possible). Typing shows matching active
 * articles, most used first; ↓ on an empty field lists the most used ones. ↑/↓ move, Enter picks,
 * Esc closes, Tab leaves the typed text. Alt+↑/↓ is left alone (row moving in the line editor).
 */
export function ArticleAutocompleteInput({
  value,
  onChange,
  onPick,
  showTax = true,
  className,
  ref,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
  onPick: (article: ArticleDTO) => void;
  /** show the article's tax rate (hide in tax modes without VAT) */
  showTax?: boolean;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange">) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(value.trim(), 120);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useQuery({ ...articlePickerQuery(q), enabled: open });
  const options = results.data ?? [];
  const visible = open && options.length > 0;

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (article: ArticleDTO) => {
    setOpen(false);
    onPick(article);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(0);
      } else setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp" && visible) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && visible) {
      e.preventDefault();
      const article = options[active];
      if (article) pick(article);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <Popover open={visible} onOpenChange={(next) => !next && setOpen(false)}>
      <PopoverAnchor asChild>
        <Input
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={listId}
          aria-activedescendant={visible && options[active] ? `${listId}-${options[active].id}` : undefined}
          {...props}
          ref={(el) => {
            inputRef.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          className={className}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(e.target.value.trim() !== "");
          }}
          onKeyDown={(e) => {
            onKeyDown(e);
            props.onKeyDown?.(e);
          }}
          onBlur={(e) => {
            setOpen(false);
            props.onBlur?.(e);
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-(--radix-popover-trigger-width) min-w-96 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // clicks into the input (the anchor) must not close the list
        onInteractOutside={(e) => {
          if (e.target === inputRef.current) e.preventDefault();
        }}
      >
        <div className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">Artikel übernehmen</div>
        <ul ref={listRef} id={listId} role="listbox" aria-label="Artikel" className="max-h-72 overflow-y-auto">
          {options.map((article, i) => (
            <li
              key={article.id}
              id={`${listId}-${article.id}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              // keep focus in the input
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(article)}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-sm px-2 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{article.title}</span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {formatArticleNumber(article.number)}
                  </span>
                </div>
                {article.description && (
                  <div className="truncate text-xs text-muted-foreground">{article.description}</div>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="tabular">
                  {formatCents(article.unitPriceCents)}
                  {article.unit && <span className="text-muted-foreground"> / {article.unit}</span>}
                </div>
                {showTax && (
                  <div className="tabular text-xs text-muted-foreground">{formatBp(article.taxRateBp)} USt.</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
