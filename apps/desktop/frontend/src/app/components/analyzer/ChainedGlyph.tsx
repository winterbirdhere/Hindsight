/**
 * The corner arrow before the cause of a chained miss or slider break: the cause shown is an earlier mistake's.
 * It takes the text colour. With a `label` (the chain message) it is an image with that name and hover text;
 * without one it is decoration beside text that says it.
 */
export function ChainedGlyph({ size, label }: { size: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {label && <title>{label}</title>}
      <path d="M3.5 2.5V8a2 2 0 0 0 2 2h7" />
      <path d="M9.5 7l3 3-3 3" />
    </svg>
  );
}
