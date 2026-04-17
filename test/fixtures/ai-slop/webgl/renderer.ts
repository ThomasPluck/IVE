declare const gl: WebGLRenderingContext;
declare const prog: WebGLProgram;

// Real — defined in shader.glsl
const pLoc = gl.getUniformLocation(prog, "uProjection");

// Hallucinated — LLM invented a uTexture uniform that isn't in the shader.
const tLoc = gl.getUniformLocation(prog, "uTexture");

export function draw() {
  gl.uniformMatrix4fv(pLoc, false, new Float32Array(16));
  gl.uniform1i(tLoc, 0);
}
