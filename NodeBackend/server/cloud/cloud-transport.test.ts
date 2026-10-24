import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudApiSession, GraphApiError } from '../services/CloudApiSession';

test('official campaign sends image template and correlation id without changing legacy text transport',async()=>{
  const original=globalThis.fetch;
  const requests:any[]=[];
  globalThis.fetch=async(url,init)=>{
    requests.push({url:String(url),body:init?.body ? JSON.parse(String(init.body)) : null,signal:init?.signal});
    return new Response(JSON.stringify({messages:[{id:'wamid.fixture'}]}),{status:200});
  };
  try {
    const session=new CloudApiSession({userId:'fixture',sessionName:'cloud',phoneNumberId:'phone',wabaId:'waba',accessToken:'test-only'});
    const template={name:'approved_fixture',language:{code:'en'},components:[{type:'header',parameters:[{type:'image',image:{link:'https://example.com/header.jpg'}}]}]};
    assert.equal(await session.sendCampaignTemplate('919000000001',template,'attempt-fixture'),'wamid.fixture');
    assert.deepEqual(requests[0].body,{messaging_product:'whatsapp',recipient_type:'individual',to:'919000000001',type:'template',template,biz_opaque_callback_data:'attempt-fixture'});
    assert.ok(requests[0].signal);
    session.noteInbound('919000000001');
    const legacy=await session.sendTextMessage('919000000001','Existing reply');
    assert.equal(legacy.id,'wamid.fixture');
    assert.equal(requests[1].body.type,'text');assert.equal(requests[1].body.text.body,'Existing reply');
    assert.equal(requests[1].body.biz_opaque_callback_data,undefined);
    assert.equal(requests[1].signal,undefined);
  } finally {globalThis.fetch=original;}
});
test('transport distinguishes definitive API errors from ambiguous response without message id',async()=>{
  const original=globalThis.fetch;
  const session=new CloudApiSession({userId:'fixture',sessionName:'cloud',phoneNumberId:'phone',accessToken:'test-only'});
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:131026,message:'Undeliverable'}}),{status:400});
    await assert.rejects(session.sendCampaignTemplate('919000000001',{},'id'),e=>e instanceof GraphApiError && e.code===131026 && e.httpStatus===400);
    globalThis.fetch=async()=>new Response('{}',{status:200});
    await assert.rejects(session.sendCampaignTemplate('919000000001',{},'id'),/delivery is uncertain/);
  } finally {globalThis.fetch=original;}
});
