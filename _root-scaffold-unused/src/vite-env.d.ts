/// <reference types="vite/client" />

declare module '*.js?url' {
  const url: string;
  export default url;
}

declare module 'lamejs';
declare module 'cmu-pronouncing-dictionary';
