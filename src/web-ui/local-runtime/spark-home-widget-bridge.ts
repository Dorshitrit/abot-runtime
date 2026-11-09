import { SPARK_HOME_WIDGET_MAX_HEIGHT, type SparkHomeWidgetSlot } from "../../runtime/spark-home/widgets/catalog.js";

function bridgeConfiguration(revision: number, slots: readonly SparkHomeWidgetSlot[]): string {
  return JSON.stringify({ revision, slots, maximumHeight: SPARK_HOME_WIDGET_MAX_HEIGHT }).replace(/</g, "\\u003c");
}

/** Runs inside untrusted content: reports geometry only and receives only bounded heights. */
export function sparkHomeWidgetGeometryScript(revision: number, slots: readonly SparkHomeWidgetSlot[]): string {
  return `<script>(()=>{
const config=${bridgeConfiguration(revision, slots)};
function startWidgetGeometry(){
const nodes=new Map(config.slots.map(slot=>[slot.instanceId,document.querySelector('[data-abot-widget-slot="'+slot.instanceId+'"]')]));
let scheduled=false;
let previous='';
function setHeight(id,height){
  const node=nodes.get(id);
  if(!node)return;
  for(const name of ['height','minHeight','maxHeight'])node.style[name]=height+'px';
  node.style.boxSizing='border-box';
}
function captureGeometry(slot){
  const node=nodes.get(slot.instanceId);
  if(!node?.isConnected)return {instanceId:slot.instanceId};
  const rect=node.getBoundingClientRect();
  return {instanceId:slot.instanceId,x:rect.x,y:rect.y,width:rect.width,height:rect.height};
}
function report(){
  scheduled=false;
  const entries=config.slots.map(captureGeometry);
  const encoded=JSON.stringify(entries);
  if(encoded===previous)return;
  previous=encoded;
  parent.postMessage({kind:'abot.spark-home-widget-geometry',version:1,revision:config.revision,entries},'*');
}
function schedule(){
  if(scheduled)return;
  scheduled=true;
  requestAnimationFrame(report);
}
function isCurrentSizingMessage(event){
  if(event.source!==parent)return false;
  const data=event.data;
  if(data?.kind!=='abot.spark-home-widget-sizing'||data.version!==1)return false;
  if(data.revision!==config.revision)return false;
  if(!Array.isArray(data.sizes))return false;
  return data.sizes.length<=config.slots.length;
}
function isBoundedWidgetSize(size){
  if(!size||!nodes.has(size.instanceId))return false;
  if(!Number.isFinite(size.height)||size.height<0)return false;
  return size.height<=config.maximumHeight;
}
addEventListener('message',event=>{
  if(!isCurrentSizingMessage(event))return;
  for(const size of event.data.sizes){
    if(isBoundedWidgetSize(size))setHeight(size.instanceId,Math.round(size.height));
  }
  schedule();
});
for(const slot of config.slots)setHeight(slot.instanceId,slot.defaultHeight);
for(const name of ['resize','scroll','load','transitionend','animationend'])addEventListener(name,schedule,true);
new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true});
if(typeof ResizeObserver==='function'){
  const observer=new ResizeObserver(schedule);
  observer.observe(document.documentElement);
  for(const node of nodes.values())if(node)observer.observe(node);
}
schedule();
}
if(document.readyState==='loading'){
  addEventListener('DOMContentLoaded',startWidgetGeometry,{once:true});
  return;
}
startWidgetGeometry();
})();</script>`;
}

/** Trusted outer wrapper binds geometry to the server's manifest; no action messages exist. */
export function sparkHomeWidgetRelayScript(revision: number, slots: readonly SparkHomeWidgetSlot[]): string {
  return `<script>(()=>{
const config=${bridgeConfiguration(revision, slots)};
const known=new Map(config.slots.map(slot=>[slot.instanceId,slot]));
const frame=()=>document.querySelector('iframe');
let previous=[];
function captureBoundedWidgetRect(entry){
  if(!entry||typeof entry!=='object')return null;
  for(const key of ['x','y','width','height']){
    if(!Number.isFinite(entry[key])||Math.abs(entry[key])>1000000)return null;
  }
  if(entry.width<=0||entry.height<=0)return null;
  return {x:entry.x,y:entry.y,width:entry.width,height:entry.height};
}
function publish(entries=previous){
  previous=entries;
  const geometry=new Map(entries.filter(entry=>entry&&known.has(entry.instanceId)).map(entry=>[entry.instanceId,captureBoundedWidgetRect(entry)]));
  const slots=config.slots.map(slot=>({instanceId:slot.instanceId,widgetId:slot.widgetId,rect:geometry.get(slot.instanceId)||null}));
  parent.postMessage({kind:'abot.spark-home-widgets',version:1,revision:config.revision,slots},'*');
}
function isCurrentWidgetMessage(data){
  if(!data||data.version!==1)return false;
  return data.revision===config.revision;
}
function isBoundedWidgetSize(size){
  if(!size||!known.has(size.instanceId))return false;
  if(!Number.isFinite(size.height)||size.height<0)return false;
  return size.height<=config.maximumHeight;
}
addEventListener('message',event=>{
  const data=event.data;
  const child=frame()?.contentWindow;
  if(!isCurrentWidgetMessage(data))return;
  if(event.source===child&&data.kind==='abot.spark-home-widget-geometry'){
    if(!Array.isArray(data.entries)||data.entries.length>config.slots.length)return;
    publish(data.entries);
    return;
  }
  if(event.source!==parent||data.kind!=='abot.spark-home-widget-sizing'||!child)return;
  if(!Array.isArray(data.sizes)||data.sizes.length>config.slots.length)return;
  const sizes=data.sizes.filter(isBoundedWidgetSize).map(size=>({instanceId:size.instanceId,height:Math.round(size.height)}));
  child.postMessage({kind:'abot.spark-home-widget-sizing',version:1,revision:config.revision,sizes},'*');
});
addEventListener('DOMContentLoaded',()=>publish());
})();</script>`;
}
