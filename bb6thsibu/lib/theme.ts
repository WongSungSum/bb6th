// 主题（深色 / 浅色）。颜色本身都在 app/globals.css
export const THEME_KEY = 'theme';

// 在 <head> 里先跑，画面出来前就设好 <html data-theme>，避免闪一下；跟随系统时也会随系统切换
export const themeScript = `(function(){try{var m=matchMedia('(prefers-color-scheme: light)');var a=function(){var p=localStorage.getItem('${THEME_KEY}')||'system';document.documentElement.dataset.theme=p==='system'?(m.matches?'light':'dark'):p};a();m.addEventListener('change',a);window.__applyTheme=a}catch(e){}})()`;
