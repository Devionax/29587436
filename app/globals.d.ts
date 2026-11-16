declare module "*.css";

// `s-app-nav` is provided by App Bridge, not by Polaris web components, so it is
// missing from @shopify/polaris-types. Declare only the surface we use.
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement>,
      HTMLElement
    >;
  }
}
