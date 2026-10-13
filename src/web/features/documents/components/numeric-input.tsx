import { useState } from "react";
import { centsToInput, formatCentsPlain, formatQuantity, parseMoneyToCents, parseQuantity } from "@shared/money";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Codec {
  /** shown while not focused */
  display: (v: number) => string;
  /** shown while editing */
  edit: (v: number) => string;
  parse: (s: string) => number | null;
}

const bpFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });

export const CODECS = {
  /** integer cents */
  money: { display: formatCentsPlain, edit: centsToInput, parse: parseMoneyToCents },
  /** milli-units */
  quantity: { display: formatQuantity, edit: formatQuantity, parse: parseQuantity },
  /** basis points shown as percent ("10" → 1000); "x * 100" parsing = cents parsing */
  percent: {
    display: (bp) => bpFormatter.format(bp / 100),
    edit: (bp) => bpFormatter.format(bp / 100),
    parse: parseMoneyToCents,
  },
} satisfies Record<string, Codec>;

/**
 * de-AT number input holding an integer in canonical units (cents, milli-units, bp).
 * While typing, every parseable value is emitted (live totals); on blur the text is re-formatted
 * and invalid input reverts to the last valid value.
 */
export function NumericInput({
  value,
  onChange,
  codec,
  min,
  className,
  ...props
}: {
  value: number;
  onChange: (value: number) => void;
  codec: Codec;
  min?: number;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type" | "min">) {
  const [text, setText] = useState<string | null>(null);
  const parse = (s: string) => {
    const v = codec.parse(s);
    return v === null || (min !== undefined && v < min) ? null : v;
  };

  return (
    <Input
      inputMode="decimal"
      autoComplete="off"
      {...props}
      className={cn("tabular text-right", className)}
      value={text ?? codec.display(value)}
      aria-invalid={text !== null && parse(text) === null ? true : props["aria-invalid"]}
      onFocus={(e) => {
        setText(codec.edit(value));
        requestAnimationFrame(() => e.target.select());
        props.onFocus?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parse(e.target.value);
        if (v !== null && v !== value) onChange(v);
      }}
      onBlur={(e) => {
        setText(null);
        props.onBlur?.(e);
      }}
    />
  );
}
