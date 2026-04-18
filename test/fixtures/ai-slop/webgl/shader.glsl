precision mediump float;
uniform mat4 uProjection;
uniform vec3 uLight;
varying vec2 vUv;

void main() {
    gl_FragColor = vec4(uLight * vUv.x, 1.0);
}
