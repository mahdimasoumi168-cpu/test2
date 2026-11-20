if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(()=>{});
const $=id=>document.getElementById(id), form=$("loginForm"), notice=$("notice");
let token=null,socket=null,room=null,holding=false,joiningRoom=false,memberOffset=0;
form.addEventListener("submit",async e=>{e.preventDefault();notice.textContent="در حال بررسی اطلاعات...";
try{const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fullName:$("fullName").value,guardianCode:$("guardianCode").value,personCode:$("personCode").value})});
const data=await r.json();if(!r.ok)throw new Error(data.error||"ورود انجام نشد.");token=data.token;$("login").style.display="none";$("app").style.display="block";$("welcome").textContent="خوش آمدید، "+data.member.name+(data.member.role==="admin"?" · مدیر":"");if(data.member.role==="admin"){$("adminPanel").hidden=false;loadMembers();loadAdminRooms();}loadRooms();connect();}catch(err){notice.textContent=err.message||"ارتباط با سرور برقرار نشد."}});
async function api(url,options={}){const r=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:"Bearer "+token,"Content-Type":"application/json"}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"درخواست انجام نشد.");return d;}
async function loadMembers(reset=true){try{if(reset){memberOffset=0;$("memberList").innerHTML="";}const q=encodeURIComponent($("memberSearch").value.trim());const d=await api("/api/admin/members?limit=50&offset="+memberOffset+"&q="+q);d.members.forEach(m=>{const row=document.createElement("div");row.className="status";row.textContent=m.full_name+" · "+(m.role==="admin"?"مدیر":"عضو")+" · "+(m.active?"فعال":"غیرفعال");const role=document.createElement("button");role.className="room";role.textContent=m.role==="admin"?"تبدیل به عضو":"ارتقای مدیر";role.addEventListener("click",async()=>{try{await api("/api/admin/members/"+m.id,{method:"PATCH",body:JSON.stringify({role:m.role==="admin"?"member":"admin"})});await loadMembers();}catch(e){$("adminNotice").textContent=e.message;}});const edit=document.createElement("button");edit.className="room";edit.textContent="ویرایش مشخصات";edit.addEventListener("click",async()=>{const fullName=prompt("نام و نام خانوادگی",m.full_name);if(fullName===null)return;const guardianCode=prompt("کد سرپرستی جدید (خالی = بدون تغییر)","");if(guardianCode===null)return;const personCode=prompt("کد شخص جدید (خالی = بدون تغییر)","");if(personCode===null)return;const body={fullName};if(guardianCode.trim())body.guardianCode=guardianCode;if(personCode.trim())body.personCode=personCode;try{await api("/api/admin/members/"+m.id,{method:"PATCH",body:JSON.stringify(body)});await loadMembers();}catch(e){$("adminNotice").textContent=e.message;}});const active=document.createElement("button");active.className="room";active.textContent=m.active?"غیرفعال‌کردن":"فعال‌کردن";active.addEventListener("click",async()=>{try{await api("/api/admin/members/"+m.id+"/active",{method:"PATCH",body:JSON.stringify({active:!m.active})});await loadMembers();}catch(e){$("adminNotice").textContent=e.message;}});row.append(" ",edit," ",role," ",active);$("memberList").append(row);});memberOffset=d.nextOffset??0;$("moreMembers").hidden=d.nextOffset===null;}catch(e){$("adminNotice").textContent=e.message;}}
$("memberForm").addEventListener("submit",async e=>{e.preventDefault();try{await api("/api/admin/members",{method:"POST",body:JSON.stringify({fullName:$("newName").value,guardianCode:$("newGuardian").value,personCode:$("newPerson").value,role:$("newRole").value})});e.target.reset();$("adminNotice").textContent="عضو ثبت شد.";loadMembers();}catch(err){$("adminNotice").textContent=err.message;}});
$("moreMembers").addEventListener("click",()=>loadMembers(false));
$("searchMembers").addEventListener("click",()=>loadMembers(true));
$("memberSearch").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();loadMembers(true);}});
async function loadRooms(){try{const d=await api("/api/rooms");const grid=$("roomGrid");grid.innerHTML="";d.rooms.forEach(r=>{const b=document.createElement("button");b.className="room";b.dataset.room=r.id;b.textContent=r.name;grid.append(b);});}catch(e){$("status").textContent=e.message;}}
async function loadAdminRooms(){try{const d=await api("/api/admin/rooms");const list=$("roomAdminList");list.innerHTML="";d.rooms.forEach(r=>{const row=document.createElement("div");row.className="status";row.textContent=r.name+" · "+r.connected_members+"/"+r.max_members+" نفر · "+(r.active?"فعال":"غیرفعال");const edit=document.createElement("button");edit.className="room";edit.textContent="ویرایش نام/ظرفیت";edit.addEventListener("click",async()=>{const name=prompt("نام اتاق",r.name);if(name===null)return;const capacity=prompt("ظرفیت (۱ تا ۵۰۰)",String(r.max_members));if(capacity===null)return;try{await api("/api/admin/rooms/"+r.id,{method:"PATCH",body:JSON.stringify({name,maxMembers:Number(capacity)})});await loadAdminRooms();}catch(e){$("adminNotice").textContent=e.message;}});row.append(" ",edit);if(r.id!=="management"){const b=document.createElement("button");b.className="room";b.textContent=r.active?"غیرفعال‌کردن":"فعال‌کردن";b.addEventListener("click",async()=>{try{await api("/api/admin/rooms/"+r.id+"/active",{method:"PATCH",body:JSON.stringify({active:!r.active})});await loadAdminRooms();await loadRooms();}catch(e){$("adminNotice").textContent=e.message;}});row.append(" ",b);}list.append(row);});}catch(e){$("adminNotice").textContent=e.message;}}
$("roomForm").addEventListener("submit",async e=>{e.preventDefault();try{await api("/api/admin/rooms",{method:"POST",body:JSON.stringify({name:$("newRoomName").value,maxMembers:Number($("newRoomCapacity").value)})});$("newRoomName").value="";$("newRoomCapacity").value="50";$("adminNotice").textContent="اتاق جدید ایجاد شد.";await loadAdminRooms();await loadRooms();}catch(err){$("adminNotice").textContent=err.message;}});
$("loadAudit").addEventListener("click",async()=>{try{const d=await api("/api/admin/audit?limit=100");const list=$("auditList");list.innerHTML="";d.events.forEach(event=>{const row=document.createElement("div");row.className="status";row.textContent=event.created_at+" · "+event.event_type+" · "+(event.target_id||"");list.append(row);});}catch(e){$("adminNotice").textContent=e.message;}});

let publisher=null,subscriber=null,roomHeartbeat=null,pttHeartbeat=null,talkGeneration=0,subscriberGeneration=0;
const remoteAudio=$("remoteAudio");
function connect(){setStatus("یک اتاق ارتباطی انتخاب کنید.");}
function setStatus(value){$("status").textContent=value;}
function isSocketOpen(){return socket&&socket.readyState===WebSocket.OPEN;}
function sendSocket(type,extra={}){if(isSocketOpen())socket.send(JSON.stringify({type,...extra}));}
function waitIceGatheringComplete(pc,timeoutMs=10000){
  if(pc.iceGatheringState==="complete")return Promise.resolve();
  return new Promise(resolve=>{
    let finished=false;
    const done=()=>{if(finished)return;finished=true;clearTimeout(timer);pc.removeEventListener("icegatheringstatechange",check);resolve();};
    const check=()=>{if(pc.iceGatheringState==="complete")done();};
    const timer=setTimeout(done,timeoutMs);
    pc.addEventListener("icegatheringstatechange",check);
  });
}
function waitConnected(pc,timeoutMs=18000){
  if(pc.connectionState==="connected")return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error("مهلت برقراری ارتباط صوتی تمام شد.")),timeoutMs);
    const check=()=>{
      if(pc.connectionState==="connected")finish();
      else if(["failed","closed"].includes(pc.connectionState))finish(new Error("اتصال صوتی برقرار نشد."));
    };
    const finish=error=>{
      clearTimeout(timer);pc.removeEventListener("connectionstatechange",check);
      error?reject(error):resolve();
    };
    pc.addEventListener("connectionstatechange",check);check();
  });
}
async function makePeerConnection(){
  let iceServers=[{urls:"stun:stun.cloudflare.com:3478"}];
  try{const data=await api("/api/ice-servers");if(Array.isArray(data.iceServers)&&data.iceServers.length)iceServers=data.iceServers;}catch{}
  return new RTCPeerConnection({iceServers});
}
async function closeSession(sessionId){
  if(!sessionId||!token)return;
  try{await api("/api/sfu/sessions/"+encodeURIComponent(sessionId),{method:"DELETE"});}catch{}
}
async function cleanupPublisher(){
  const active=publisher;publisher=null;
  if(!active)return;
  try{active.pc.onconnectionstatechange=null;active.pc.close();}catch{}
  try{await active.microphone.close();}catch{}
  await closeSession(active.sessionId);
}
async function cleanupSubscriber(){
  subscriberGeneration++;
  const active=subscriber;subscriber=null;
  if(active){try{active.pc.onconnectionstatechange=null;active.pc.close();}catch{}await closeSession(active.sessionId);}
  if(remoteAudio){remoteAudio.pause();remoteAudio.srcObject=null;}
}
function currentTalk(generation){return holding&&generation===talkGeneration&&isSocketOpen()&&Boolean(room);}
async function startPublisher(){
  const generation=talkGeneration;
  let sessionId=null,microphone=null,pc=null;
  try{
    if(!currentTalk(generation)||publisher)return;
    const created=await api("/api/sfu/sessions",{method:"POST",body:JSON.stringify({roomId:room,type:"publisher"})});
    sessionId=created.sessionId;
    if(!currentTalk(generation))throw new Error("لغو شد");
    if(!window.HamyarAudio?.createProcessedMicrophone)throw new Error("پردازش میکروفون بارگذاری نشده است.");
    microphone=await HamyarAudio.createProcessedMicrophone();
    if(!currentTalk(generation))throw new Error("لغو شد");
    pc=await makePeerConnection();
    const transceiver=pc.addTransceiver(microphone.track,{direction:"sendonly"});
    const sender=transceiver.sender;
    try{
      const parameters=sender.getParameters();
      parameters.encodings=parameters.encodings?.length?parameters.encodings:[{}];
      parameters.encodings[0].maxBitrate=20000;
      await sender.setParameters(parameters);
    }catch{}
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceGatheringComplete(pc);
    if(!currentTalk(generation))throw new Error("لغو شد");
    const mid=transceiver.mid;
    if(mid===null||mid===undefined)throw new Error("شناسه ترک صوتی ساخته نشد.");
    const answer=await api("/api/sfu/sessions/"+encodeURIComponent(sessionId)+"/publish",{
      method:"POST",body:JSON.stringify({sessionDescription:pc.localDescription,mid})
    });
    if(!answer.sessionDescription)throw new Error("پاسخ SFU برای انتشار صوت دریافت نشد.");
    await pc.setRemoteDescription(answer.sessionDescription);
    await waitConnected(pc);
    if(!currentTalk(generation))throw new Error("لغو شد");
    publisher={sessionId,pc,microphone,mid};
    sendSocket("ptt:published",{sessionId});
    setStatus("صدای شما در اتاق منتشر می‌شود؛ برای پایان صحبت دکمه را رها کنید.");
    pc.addEventListener("connectionstatechange",()=>{
      if(publisher?.pc===pc&&["failed","disconnected"].includes(pc.connectionState)){
        setStatus("اتصال صوتی ناپایدار شد؛ نوبت صحبت آزاد می‌شود.");releaseTalk();
      }
    });
  }catch(error){
    try{pc?.close();}catch{}
    try{await microphone?.close();}catch{}
    await closeSession(sessionId);
    if(error.message!=="لغو شد"){
      setStatus(error.message||"شروع انتشار صدا ناموفق بود.");
      if(holding)releaseTalk();
    }
  }
}
async function startSubscriber(publisherSessionId){
  if(!publisherSessionId||!room||!isSocketOpen())return;
  if(subscriber?.publisherSessionId===publisherSessionId)return;
  await cleanupSubscriber();
  const generation=++subscriberGeneration;
  let sessionId=null,pc=null;
  const valid=()=>generation===subscriberGeneration&&Boolean(room)&&isSocketOpen();
  try{
    const created=await api("/api/sfu/sessions",{method:"POST",body:JSON.stringify({roomId:room,type:"subscriber"})});
    sessionId=created.sessionId;
    if(!valid())throw new Error("لغو شد");
    pc=makePeerConnection();
    pc.addEventListener("track",event=>{
      if(!remoteAudio)return;
      remoteAudio.srcObject=event.streams?.[0]||new MediaStream([event.track]);
      remoteAudio.play().catch(()=>setStatus("برای شنیدن صدا، یک‌بار صفحه را لمس کنید."));
    });
    const offer=await api("/api/sfu/sessions/"+encodeURIComponent(sessionId)+"/subscribe",{
      method:"POST",body:JSON.stringify({publisherSessionId})
    });
    if(!offer.sessionDescription)throw new Error("پیشنهاد دریافت صدا از SFU موجود نیست.");
    await pc.setRemoteDescription(offer.sessionDescription);
    const answer=await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIceGatheringComplete(pc);
    if(!valid())throw new Error("لغو شد");
    await api("/api/sfu/sessions/"+encodeURIComponent(sessionId)+"/renegotiate",{
      method:"PUT",body:JSON.stringify({sessionDescription:pc.localDescription})
    });
    await waitConnected(pc);
    if(!valid())throw new Error("لغو شد");
    subscriber={sessionId,pc,publisherSessionId};
    setStatus("در حال دریافت صدای زنده از "+(activeSpeakerName||"گوینده")+" هستید.");
    pc.addEventListener("connectionstatechange",()=>{
      if(subscriber?.pc===pc&&["failed","disconnected"].includes(pc.connectionState)){
        setStatus("دریافت صدا قطع شد؛ در حال تلاش برای اتصال دوباره.");
      }
    });
  }catch(error){
    try{pc?.close();}catch{}
    await closeSession(sessionId);
    if(error.message!=="لغو شد")setStatus(error.message||"اتصال دریافت صدا ناموفق بود.");
  }
}
let activeSpeakerName="";
async function stopAllMedia(){await cleanupPublisher();await cleanupSubscriber();}
function closeRoom(){
  releaseTalk();
  if(roomHeartbeat){clearInterval(roomHeartbeat);roomHeartbeat=null;}
  const old=socket;socket=null;room=null;
  if(old){try{old.close();}catch{}}
  $("ptt").disabled=true;
  document.querySelectorAll("#roomGrid .room").forEach(x=>x.classList.remove("selected"));
  stopAllMedia();
}
function connectRoom(nextRoom,button){
  closeRoom();
  room=nextRoom;
  const scheme=location.protocol==="https:"?"wss:":"ws:";
  const wsUrl=scheme+"//"+location.host+"/api/rooms/"+encodeURIComponent(nextRoom)+"/socket";
  const current=new WebSocket(wsUrl,["hy-room-v1","hy-auth."+token]);
  socket=current;
  current.addEventListener("open",()=>{
    if(socket!==current)return;
    $("ptt").disabled=false;
    setStatus("به اتاق "+button.textContent+" متصل شدید؛ آماده دریافت صدا.");
    roomHeartbeat=setInterval(()=>{if(socket===current&&current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:"room:heartbeat"}));},240000);
  });
  current.addEventListener("message",event=>{
    if(socket!==current)return;
    let data;try{data=JSON.parse(event.data)}catch{return}
    if(data.type==="room:ready")setStatus("اتصال برقرار است · افراد حاضر: "+data.connected+" · ظرفیت اتاق: "+data.capacity);
    if(data.type==="room:presence")setStatus("اعضای متصل این اتاق: "+data.connected);
    if(data.type==="ptt:granted"){
      activeSpeakerName=data.memberName||"گوینده";
      if(data.memberId===member.id){
        if(holding)startPublisher();
        else sendSocket("ptt:release");
      }else setStatus("نوبت صحبت در اختیار "+activeSpeakerName+" است؛ در حال آماده‌سازی صدا.");
    }
    if(data.type==="ptt:published"){
      activeSpeakerName=data.memberName||"گوینده";
      if(data.memberId!==member.id)startSubscriber(data.sessionId);
      else setStatus("صدای شما برای اعضای اتاق ارسال می‌شود.");
    }
    if(data.type==="ptt:busy")setStatus(data.memberName?"اکنون "+data.memberName+" در حال صحبت است.":"فرد دیگری در حال صحبت است.");
    if(data.type==="ptt:publish-rejected"){setStatus("مجوز انتشار صدا معتبر نماند؛ کانال آزاد شد.");releaseTalk();}
    if(data.type==="ptt:released"){
      activeSpeakerName="";
      cleanupSubscriber();
      if(data.memberId===member.id||publisher)cleanupPublisher();
      setStatus("کانال آزاد شد.");
    }
    if(data.type==="room:disabled"){closeRoom();loadRooms();setStatus("این اتاق توسط مدیر غیرفعال شد.");}
    if(data.type==="session:revoked"){closeRoom();location.reload();}
  });
  current.addEventListener("close",()=>{
    if(socket!==current)return;
    socket=null;room=null;holding=false;
    if(roomHeartbeat){clearInterval(roomHeartbeat);roomHeartbeat=null;}
    $("ptt").disabled=true;
    stopAllMedia();
    setStatus("ارتباط قطع شد؛ برای اتصال دوباره اتاق را انتخاب کنید.");
  });
  current.addEventListener("error",()=>{if(socket===current)setStatus("خطا در اتصال اتاق.");});
  document.querySelectorAll("#roomGrid .room").forEach(x=>x.classList.toggle("selected",x===button));
}
$("roomGrid").addEventListener("click",e=>{
  const button=e.target.closest("[data-room]");
  if(!button)return;
  if(socket&&socket.readyState===WebSocket.CONNECTING)return;
  connectRoom(button.dataset.room,button);
});
const ptt=$("ptt");
let heartbeat=null;
function request(){
  if(!room||!isSocketOpen()||holding)return;
  holding=true;talkGeneration++;
  sendSocket("ptt:request");
  heartbeat=setInterval(()=>{if(holding&&isSocketOpen())sendSocket("ptt:heartbeat");},5000);
}
function releaseTalk(){
  if(!holding)return;
  holding=false;talkGeneration++;
  if(heartbeat){clearInterval(heartbeat);heartbeat=null;}
  sendSocket("ptt:release");
  cleanupPublisher();
}
ptt.setAttribute("role","button");ptt.tabIndex=0;ptt.setAttribute("aria-label","برای صحبت، دکمه را نگه دارید");
ptt.addEventListener("pointerdown",e=>{e.preventDefault();try{ptt.setPointerCapture(e.pointerId);}catch{}request()});
["pointerup","pointercancel","lostpointercapture"].forEach(ev=>ptt.addEventListener(ev,releaseTalk));
ptt.addEventListener("keydown",e=>{if((e.code==="Space"||e.code==="Enter")&&!e.repeat){e.preventDefault();request();}});
ptt.addEventListener("keyup",e=>{if(e.code==="Space"||e.code==="Enter"){e.preventDefault();releaseTalk();}});
ptt.addEventListener("blur",releaseTalk);
document.addEventListener("visibilitychange",()=>{if(document.hidden)releaseTalk();});
window.addEventListener("blur",releaseTalk);
window.addEventListener("pagehide",()=>{releaseTalk();});
$("logout").addEventListener("click",()=>{closeRoom();token=null;location.reload();});
