import {createContext,useContext,useEffect,useState,useSyncExternalStore,type ReactNode} from 'react';
import {DemoController} from './controller';

const Context=createContext<DemoController|null>(null);
export function DemoProvider({children,controller}:{children:ReactNode;controller?:DemoController}){
 const [model]=useState(()=>controller??new DemoController());
 // Restores saved state with GETs only. A page load never sends a command.
 useEffect(()=>{void model.load();},[model]);
 return <Context.Provider value={model}>{children}</Context.Provider>;
}
export function useDemo(){
 const model=useContext(Context);if(!model)throw new Error('Missing DemoProvider');
 return {model,...useSyncExternalStore(model.subscribe,model.getSnapshot)};
}
