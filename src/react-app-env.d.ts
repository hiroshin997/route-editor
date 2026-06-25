/// <reference types="react-scripts" />

// Allow side-effect CSS imports (e.g. import './App.css')
declare module '*.css' {
  const styles: { readonly [className: string]: string };
  export default styles;
}
