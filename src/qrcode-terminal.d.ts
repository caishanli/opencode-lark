declare module "qrcode-terminal" {
  export function generate(url: string, options?: { small?: boolean }): void
  const qrcode: { generate(url: string, options?: { small?: boolean }): void }
  export default qrcode
}