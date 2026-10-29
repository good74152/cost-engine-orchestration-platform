import {createContext,useContext,useState,useSyncExternalStore,type ReactNode} from 'react';
import {DemoController} from './demo-controller';
const Context=createContext<DemoController|null>(null);
export function DemoProvider({children,controller}:{children:ReactNode;controller?:DemoController}){
 // Access storage lazily so restricted browsers render a safe error instead of
 // crashing before a user can read the session/start screen.
 const [model]=useState(()=>controller??new DemoController({
  get length(){return window.localStorage.length;},key:i=>window.localStorage.key(i),
  getItem:key=>window.localStorage.getItem(key),setItem:(key,value)=>window.localStorage.setItem(key,value),
  removeItem:key=>window.localStorage.removeItem(key),clear:()=>window.localStorage.clear(),
 }));
 // App's route effect restores Session, availability and resources together,
 // including the selected Backend Template. It performs GETs only.
 return <Context.Provider value={model}>{children}</Context.Provider>;
}
export function useDemo(){
 const model=useContext(Context);if(!model)throw new Error('Missing DemoProvider');
 return {model,...useSyncExternalStore(model.subscribe,model.getSnapshot)};
}
