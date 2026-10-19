import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Maximize, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { FULL_QUAD, type Quad, quadProblem } from "@shared/receipt-crop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { apiErrorMessage, type Expense, receiptDetectQuery, receiptOriginalUrl, useCropReceipt } from "@/sdk";

const CORNER_LABELS = ["oben links", "oben rechts", "unten rechts", "unten links"];
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Cut out and straighten a photographed receipt: the original photo with the suggested outline (local
 * detection, only while the dialog is open) and four draggable corners. Saving always crops the original.
 */
export function ReceiptCropDialog({
  expense,
  open,
  onOpenChange,
}: {
  expense: Expense;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detect = useQuery({ ...receiptDetectQuery(expense), enabled: open });
  const crop = useCropReceipt();
  const [quad, setQuad] = useState<Quad>(FULL_QUAD);
  const [enhance, setEnhance] = useState(false);
  const touched = useRef(false);

  // take the suggestion unless the user already moved a corner
  useEffect(() => {
    if (!open) {
      touched.current = false;
      return;
    }
    if (detect.data && !touched.current) setQuad(detect.data.quad ?? FULL_QUAD);
  }, [open, detect.data]);

  const move = (next: Quad) => {
    touched.current = true;
    setQuad(next);
  };

  const autoDetect = () => {
    touched.current = false;
    if (detect.data) setQuad(detect.data.quad ?? FULL_QUAD);
    else void detect.refetch();
  };

  const problem = quadProblem(quad);
  const save = () =>
    crop.mutate(
      { id: expense.id, json: { quad: quad.map(([x, y]) => [round4(x), round4(y)]) as Quad, enhance } },
      {
        onSuccess: () => {
          toast.success("Beleg zugeschnitten");
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Beleg zuschneiden</DialogTitle>
          <DialogDescription>
            Ziehen Sie die Ecken auf die Ränder des Belegs. Der Ausschnitt wird gerade gerückt, das Originalfoto bleibt erhalten.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-64 items-center justify-center rounded-md bg-muted/50 p-3">
          <QuadEditor src={receiptOriginalUrl(expense)!} quad={quad} onChange={move} />
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button type="button" variant="outline" size="sm" onClick={autoDetect} disabled={detect.isFetching}>
            {detect.isFetching ? <Loader2 className="animate-spin" /> : <ScanLine />} Automatisch erkennen
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => move(FULL_QUAD)}>
            <Maximize /> Ganzes Bild
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Switch id="crop-enhance" checked={enhance} onCheckedChange={setEnhance} />
            <Label htmlFor="crop-enhance" className="font-normal">
              Schwarz-Weiß, mehr Kontrast
            </Label>
          </div>
        </div>
        <p className={cn("-mt-2 min-h-5 text-sm text-muted-foreground", problem && "text-destructive")}>
          {problem ??
            (detect.isFetching
              ? "Beleg wird erkannt …"
              : detect.error
                ? apiErrorMessage(detect.error)
                : detect.data && !detect.data.quad
                  ? "Kein Beleg erkannt – bitte die Ecken selbst setzen."
                  : detect.data && !touched.current
                    ? "Automatisch erkannt – bei Bedarf die Ecken anpassen."
                    : "")}
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button type="button" onClick={save} disabled={!!problem || crop.isPending}>
            {crop.isPending && <Loader2 className="animate-spin" />} Zuschneiden speichern
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The image with the quad drawn over it; corners drag with pointer events and move with the arrow keys. */
function QuadEditor({ src, quad, onChange }: { src: string; quad: Quad; onChange: (q: Quad) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);

  const setCorner = (i: number, x: number, y: number) => {
    const next = quad.map((p) => [...p]) as Quad;
    next[i] = [clamp(x), clamp(y)];
    onChange(next);
  };

  const onPointerMove = (i: number) => (e: React.PointerEvent) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setCorner(i, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  const onKeyDown = (i: number) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.02 : 0.004;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    setCorner(i, quad[i][0] + d[0]!, quad[i][1] + d[1]!);
  };

  const points = quad.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

  return (
    <div ref={box} className="relative inline-block touch-none select-none">
      <img
        src={src}
        alt="Originalfoto des Belegs"
        draggable={false}
        onLoad={() => setLoaded(true)}
        className="block max-h-[60vh] max-w-full"
      />
      {loaded && (
        <>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 size-full">
            {/* dim everything outside the quad */}
            <path d={`M0,0H100V100H0Z M${points.replaceAll(" ", " L")}Z`} fill="rgb(0 0 0 / 0.45)" fillRule="evenodd" />
            <polygon points={points} fill="none" stroke="white" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <polygon
              points={points}
              fill="none"
              className="stroke-primary dark:stroke-info"
              strokeWidth={1}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {quad.map(([x, y], i) => (
            <button
              key={i}
              type="button"
              aria-label={`Ecke ${CORNER_LABELS[i]}`}
              title={`Ecke ${CORNER_LABELS[i]} – ziehen oder mit den Pfeiltasten verschieben`}
              className="group absolute flex size-8 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full outline-none active:cursor-grabbing"
              style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.focus();
              }}
              onPointerMove={onPointerMove(i)}
              onKeyDown={onKeyDown(i)}
            >
              <span className="size-4 rounded-full border-2 border-white bg-primary shadow-md ring-primary/40 dark:bg-info dark:ring-info/40 transition-transform group-focus-visible:scale-125 group-focus-visible:ring-4 group-active:scale-125" />
            </button>
          ))}
        </>
      )}
    </div>
  );
}
