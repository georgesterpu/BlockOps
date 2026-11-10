import { createHmac, timingSafeEqual } from 'node:crypto';
export function equal(a: string, b: string): boolean {
  const aa=Buffer.from(a), bb=Buffer.from(b); return aa.length===bb.length && timingSafeEqual(aa,bb);
}
export function session(secret: string, now = Date.now()) {
  const expires=String(now+8*60*60_000); return `${expires}.${createHmac('sha256',secret).update(expires).digest('hex')}`;
}
export function validSession(request: Request, secret: string, now = Date.now()): boolean {
  const value=request.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith('blockops_session='))?.slice(17);
  if(!value) return false;
  const [expires,signature]=value.split('.');
  return Number(expires)>now && Number(expires)<=now+8*60*60_000 && equal(signature || '',createHmac('sha256',secret).update(expires).digest('hex'));
}
export function validTwilio(request: Request, params: URLSearchParams, publicUrl: string, token: string): boolean {
  if(!token) return false;
  const url=new URL(request.url);
  const base=publicUrl.replace(/\/$/,'')+url.pathname+url.search;
  let message=base;
  for(const key of [...new Set(params.keys())].sort()) for(const val of [...new Set(params.getAll(key))].sort()) message+=key+val;
  return equal(request.headers.get('x-twilio-signature') || '',createHmac('sha1',token).update(message).digest('base64'));
}
