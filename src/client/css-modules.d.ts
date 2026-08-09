/**
 * CSS-modules typing for the client half (mirror of the dsh
 * `css-modules.d.ts` convention): the build-client CSS-modules transform
 * compiles `*.module.css` into a hashed class map default export.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
