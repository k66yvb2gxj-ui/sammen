(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let i=0;i<100&&!document.querySelector('.nav-item');i++)await wait(50);
  if(!document.querySelector('.nav-item'))throw Error('UI did not start');
  let state=await window.sammen.getState(); const projectId=state.projects[0].id;
  await window.sammen.saveProject({id:projectId,title:'Biologi · læring sammen',description:'Demoprosjekt for kontroll av grensesnittet',color:'#647a64'});
  await window.sammen.saveItem({projectId,title:'Demonstrasjon: celleånding',type:'note',content:'Et arbeidsnotat for UI-testen.\n\n• Undersøk originalkildene\n• Skriv med egne ord\n• Lag ett spørsmål til repetisjon'});
  await window.sammen.saveCard({projectId,question:'Demonstrasjonsspørsmål',answer:'Et eksempel på et kort svar'});
  await wait(100);
  document.querySelector('#navigation button[title="Brain"]').click(); await wait(50);
  const note=[...document.querySelectorAll('.brain-graph-node')].find(el=>el.getAttribute('aria-label')==='Åpne Demonstrasjon: celleånding');
  const circle=note?.querySelector('.brain-node-shape');
  if(!circle)throw Error('Note not visible in Brain graph');
  circle.dispatchEvent(new MouseEvent('click',{bubbles:true}));await wait(50);
  const editor=document.getElementById('editor-content');
  if(!editor)throw Error('Editor not visible');
  editor.value='Notatet er lagret gjennom det faktiske Windows-grensesnittet.';editor.dispatchEvent(new Event('input',{bubbles:true}));
  document.getElementById('save-editor').click(); await wait(250);
  state=await window.sammen.getState();
  if(!state.items.some(item=>item.content===editor.value))throw Error('Note save failed');
  const doctor=await window.sammen.doctorOneNote();
  if(doctor.contentRead!==false)throw Error('Doctor read content unexpectedly');
  return {passed:true,checks:['Electron startup','renderer/preload/main IPC','SQLite save through actual note editor','OneNote registration-only diagnostic'],oneNote:doctor};
})()
