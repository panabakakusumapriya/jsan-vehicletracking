import { WebView } from 'react-native-webview';

export interface MapPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  recordedAt: string;
}

function buildHtml(points: MapPoint[]): string {
  const latlngs = JSON.stringify(points.map(p => [p.lat, p.lon]));
  const speeds  = JSON.stringify(points.map(p => p.speedKmh));
  const center  = points.length
    ? [points[Math.floor(points.length / 2)].lat, points[Math.floor(points.length / 2)].lon]
    : [17.42, 78.45];

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>*{margin:0;padding:0}html,body,#map{width:100%;height:100%;overflow:hidden}</style>
</head><body><div id="map"></div><script>
(function(){
  var r=L.canvas({padding:0.5});
  var map=L.map('map',{zoomControl:true,renderer:r}).setView(${JSON.stringify(center)},14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  var ll=${latlngs}, sp=${speeds};
  if(!ll.length) return;
  for(var i=0;i<ll.length-1;i++){
    var c=sp[i]<40?'#059669':sp[i]<80?'#d97706':'#dc2626';
    L.polyline([ll[i],ll[i+1]],{color:c,weight:5,opacity:0.9,renderer:r}).addTo(map);
  }
  if(ll.length>1) map.fitBounds(ll,{padding:[28,28],maxZoom:17});
  else map.setView(ll[0],15);
  var si=L.divIcon({className:'',html:'<div style="width:13px;height:13px;border-radius:50%;background:#059669;border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.3)"></div>',iconSize:[13,13],iconAnchor:[6,6]});
  L.marker(ll[0],{icon:si}).addTo(map).bindPopup('<b>Trip start</b>');
  var ei=L.divIcon({className:'',html:'<div style="width:16px;height:16px;border-radius:50%;background:#7c3aed;border:3px solid #fff;box-shadow:0 2px 8px rgba(124,58,237,.5)"></div>',iconSize:[16,16],iconAnchor:[8,8]});
  L.marker(ll[ll.length-1],{icon:ei}).addTo(map).bindPopup('<b>Current</b><br>'+Math.round(sp[sp.length-1]||0)+' km/h').openPopup();
})();
</script></body></html>`;
}

export function LeafletMap({ points }: { points: MapPoint[] }) {
  return (
    <WebView
      source={{ html: buildHtml(points) }}
      style={{ flex: 1 }}
      javaScriptEnabled
      originWhitelist={['*']}
      scrollEnabled={false}
    />
  );
}
