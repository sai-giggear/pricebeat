// Magnifier for the "find competitors on Google" action. Stroke-based like the
// app's other line icons, so it inherits the button's text colour.
export default function SearchIcon() {
  return (
    <svg
      class="btn-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.5" />
      <line x1="15.5" y1="15.5" x2="21" y2="21" />
    </svg>
  );
}
