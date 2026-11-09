import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

it('binds replies to the captured pane incarnation and rejects legacy, recycled, or changed owners', {
  skip: spawnSync('tmux', ['-V']).status !== 0,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'omx-reply-bind-'));
  try {
    const code = `
      import assert from 'node:assert/strict';
      import {execFileSync} from 'node:child_process';
      import {PassThrough} from 'node:stream';
      import {EventEmitter} from 'node:events';
      import {writeFileSync} from 'node:fs';
      import {setTimeout as delay} from 'node:timers/promises';
      import {pollDiscordOnce, pollTelegramOnce} from ${JSON.stringify(new URL('../reply-listener.js', import.meta.url).href)};
      import {readReplyPaneIdentity, sendToPane} from ${JSON.stringify(new URL('../tmux-detector.js', import.meta.url).href)};
      import {registerMessage, lookupByMessageId} from ${JSON.stringify(new URL('../session-registry.js', import.meta.url).href)};
      const socket = process.env.HOME + '/tmux.sock';
      const tmux = args => execFileSync('tmux', ['-S', socket, ...args], {encoding:'utf8'});
      try {
        tmux(['new-session','-d','-s','project-a','-x','100','-y','25']);
        const pane = tmux(['display-message','-p','-t','project-a','#{pane_id}']).trim();
        process.env.TMUX = socket + ',0,0';
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-a']);
        tmux(['send-keys','-t',pane,'-l','--',"printf 'Codex audit fixture\\n'; cat"]);
        tmux(['send-keys','-t',pane,'Enter']);
        await delay(200);
        const identity = readReplyPaneIdentity(pane,'owner-a');
        assert.ok(identity);
        const mapping = {platform:'discord-bot',messageId:'notification',sessionId:'owner-a',tmuxPaneId:pane,tmuxSessionName:'project-a',tmuxIdentity:identity,event:'session-idle',createdAt:new Date().toISOString()};
        assert.equal(registerMessage(mapping),true);
        assert.deepEqual(lookupByMessageId('discord-bot','notification')?.tmuxIdentity,identity);
        const config = {enabled:true,discordEnabled:true,discordBotToken:'synthetic',discordChannelId:'synthetic',authorizedDiscordUserIds:['allowed'],includePrefix:false,maxMessageLength:500,pollIntervalMs:3000,rateLimitPerMinute:10};
        const poll = async (binding,text) => {
          const state = {isRunning:true,pid:process.pid,startedAt:null,lastPollAt:null,telegramLastUpdateId:null,discordLastMessageId:'0',messagesInjected:0,errors:0};
          await pollDiscordOnce(config,state,{canProceed:()=>true,reset(){}},{fetchImpl:async(_url,o)=>({ok:true,headers:new Headers(),json:async()=>o.method==='GET'?[{id:'1',author:{id:'allowed'},content:text,message_reference:{message_id:'notification'}}]:{}}),lookupByMessageIdImpl:()=>binding,writeDaemonStateImpl(){},captureReplyAcknowledgementSummaryImpl:()=>null,logImpl(){}});
          return state.messagesInjected;
        };
        assert.equal(await poll(mapping,'VALID_REPLY'),1);
        assert.ok(tmux(['capture-pane','-p','-t',pane]).includes('VALID_REPLY'));
        process.env.CODEX_HOME=process.env.HOME;
        process.env.no_proxy='*';
        process.env.OMX_OPENCLAW='0';
        writeFileSync(process.env.HOME+'/.omx-config.json',JSON.stringify({notifications:{enabled:true,verbosity:'agent','discord-bot':{enabled:true,botToken:'synthetic',channelId:'synthetic'}}}));
        let sent=0;
        globalThis.fetch=async(url)=>{assert.ok(String(url).includes('/channels/synthetic/messages'));sent++;return new Response(JSON.stringify({id:'fresh-'+sent}),{headers:{'content-type':'application/json'}});};
        const {notifyLifecycle}=await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)});
        const result=await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'audit question'});
        assert.equal(result?.anySuccess,true);
        const fresh=lookupByMessageId('discord-bot','fresh-1');
        assert.deepEqual(fresh?.tmuxIdentity,identity);
        assert.equal(await poll(fresh,'FRESH_NOTIFICATION_REPLY'),1);
        globalThis.fetch=async()=>{tmux(['set-option','-t','project-a','@omx_instance_id','owner-b']);return new Response(JSON.stringify({id:'delayed-notification'}));};
        await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'delayed audit question'});
        const delayed=lookupByMessageId('discord-bot','delayed-notification');
        assert.deepEqual(delayed?.tmuxIdentity,identity);
        assert.equal(await poll(delayed,'DELAYED_STALE_OWNER'),0);
        globalThis.fetch=async()=>new Response(JSON.stringify({id:'late-notification'}));
        await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'old event after replacement'});
        const late=lookupByMessageId('discord-bot','late-notification');
        assert.ok(late);
        assert.equal(await poll(late,'LATE_EVENT_WRONG_OWNER'),0);
        assert.equal(late.tmuxIdentity,undefined);
        const ownerB=readReplyPaneIdentity(pane,'owner-b');
        assert.equal(await poll({...mapping,tmuxIdentity:ownerB},'MISBOUND_SESSION_ID'),0);
        tmux(['set-option','-u','-t','project-a','@omx_instance_id']);
        globalThis.fetch=async()=>new Response(JSON.stringify({id:'unowned-notification'}));
        await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'unproven owner'});
        assert.equal(await poll(lookupByMessageId('discord-bot','unowned-notification'),'UNOWNED_REPLY'),0);
        tmux(['set-option','-t','project-a','@omx_instance_id','shared-session-owner']);
        tmux(['set-option','-p','-t',pane,'@omx_pane_instance_id','owner-a']);
        globalThis.fetch=async()=>new Response(JSON.stringify({id:'pane-scoped-notification'}));
        await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'pane-scoped owner'});
        const scoped=lookupByMessageId('discord-bot','pane-scoped-notification');
        assert.equal(scoped?.tmuxIdentity?.paneInstanceId,'owner-a');
        assert.equal(await poll(scoped,'PANE_SCOPED_VALID_REPLY'),1);
        const otherPane=tmux(['split-window','-d','-P','-F','#{pane_id}','-t',pane,'sleep 300']).trim();
        tmux(['set-option','-p','-t',otherPane,'@omx_pane_instance_id','owner-b']);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-b']);
        assert.ok(readReplyPaneIdentity(pane,'owner-a'));
        assert.equal(await poll(scoped,'SHARED_SESSION_VALID_REPLY'),1);
        assert.ok(tmux(['capture-pane','-p','-t',pane]).includes('SHARED_SESSION_VALID_REPLY'));
        assert.ok(!tmux(['capture-pane','-p','-t',otherPane]).includes('SHARED_SESSION_VALID_REPLY'));
        assert.equal(sendToPane(pane,'SHARED_SESSION_OWNER_CHANGES',true,{expectedIdentity:scoped.tmuxIdentity,sleepImpl(){tmux(['set-option','-t','project-a','@omx_instance_id','another-pane-owner']);}}),true);
        tmux(['kill-pane','-t',otherPane]);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-a']);
        tmux(['set-option','-p','-t',pane,'@omx_pane_instance_id','owner-b']);
        globalThis.fetch=async()=>new Response(JSON.stringify({id:'wrong-pane-owner'}));
        await notifyLifecycle('ask-user-question',{sessionId:'owner-a',projectPath:process.env.HOME,tmuxPaneId:pane,tmuxSession:'project-a',question:'session tag cannot override pane owner'});
        assert.equal(await poll(lookupByMessageId('discord-bot','wrong-pane-owner'),'WRONG_PANE_OWNER'),0);
        assert.equal(await poll(scoped,'CHANGED_PANE_OWNER'),0);
        tmux(['set-option','-p','-u','-t',pane,'@omx_pane_instance_id']);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-a']);
        assert.equal(await poll({...mapping,tmuxIdentity:undefined},'LEGACY_REPLY'),0);
        assert.equal(await poll({...mapping,tmuxSessionName:'project-b'},'WRONG_SESSION'),0);
        assert.equal(await poll({...mapping,tmuxIdentity:{...identity,panePid:identity.panePid+1}},'RECYCLED_PID'),0);
        assert.equal(await poll({...mapping,tmuxIdentity:{...identity,sessionCreated:'0'}},'RECYCLED_SERVER'),0);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-b']);
        assert.equal(await poll(mapping,'STALE_OWNER'),0);
        const telegramState = {isRunning:true,pid:process.pid,startedAt:null,lastPollAt:null,telegramLastUpdateId:null,discordLastMessageId:null,messagesInjected:0,errors:0};
        let telegramLookups=0;
        const mockHttps=(options,callback)=>{
          const request=new EventEmitter();
          request.end=()=>{const response=new PassThrough();response.statusCode=200;callback(response);response.end(JSON.stringify({ok:true,result:[{update_id:1,message:{message_id:2,chat:{id:777},text:'TELEGRAM_STALE_OWNER',reply_to_message:{message_id:1}}}]}));};
          request.destroy=()=>{};
          return request;
        };
        await pollTelegramOnce({...config,telegramEnabled:true,telegramBotToken:'synthetic',telegramChatId:'777'},telegramState,{canProceed:()=>true,reset(){}},{httpsRequestImpl:mockHttps,lookupByMessageIdImpl:()=>{telegramLookups++;return {...mapping,platform:'telegram'};},writeDaemonStateImpl(){},logImpl(){}});
        assert.equal(telegramLookups,1);
        assert.equal(telegramState.messagesInjected,0);
        assert.equal(telegramState.errors,1);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-a']);
        let delays = 0;
        assert.equal(sendToPane(pane,"literal 'quote' ; $(touch AUDIT_SHOULD_NOT_EXIST) #text",true,{expectedIdentity:identity,sleepImpl(){if(delays++===0)tmux(['set-option','-t','project-a','@omx_instance_id','owner-b']);}}),false);
        const screen=tmux(['capture-pane','-p','-t',pane]);
        assert.ok(screen.includes("literal 'quote' ; $(touch AUDIT_SHOULD_NOT_EXIST) #text"));
        assert.doesNotMatch(screen,/LEGACY_REPLY|WRONG_SESSION|RECYCLED_PID|RECYCLED_SERVER|STALE_OWNER|LATE_EVENT_WRONG_OWNER|MISBOUND_SESSION_ID|UNOWNED_REPLY|WRONG_PANE_OWNER|CHANGED_PANE_OWNER/);
        tmux(['set-option','-t','project-a','@omx_instance_id','owner-a']);
        assert.equal(sendToPane(pane,'PANE_OWNER_CHANGES_BEFORE_SUBMIT',true,{expectedIdentity:identity,sleepImpl(){tmux(['set-option','-p','-t',pane,'@omx_pane_instance_id','owner-b']);}}),false);
      } finally {try{tmux(['kill-server']);}catch{}}
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
