// When the help page is framed (the help panel other pages open), mark it, so its own header, heading and footer, which are the site's, are left out.
// A classic script in the head, so the mark is there before anything is drawn.
if (window.top !== window.self) document.documentElement.classList.add('embed');
