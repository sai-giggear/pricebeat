/** The PriceBeat mark: a minimal swing tag — the price tag, punched hole and
 *  all, angled the way one hangs. Colored via CSS (currentColor). */
export default function Logo(props: { size?: number }) {
  const s = () => props.size ?? 22;
  return (
    <svg
      class="mark"
      width={s()}
      height={s()}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="7.4" cy="7.4" r="1.2" fill="currentColor" />
    </svg>
  );
}
