// パーティクル数
export const PARTICLE_COUNT = 100000; // パーティクル数
export const PARTICLE_SPREAD = 15.0; // 初期配置の広がり
export const PARTICLE_MIN_SIZE = 0.08; // 粒の最小サイズ
export const PARTICLE_MAX_SIZE = 0.25; // 粒の最大サイズ
// Compute のワークグループサイズ
export const COMPUTE_WORKGROUP_SIZE = 64; // Compute のワークグループサイズ

// 半透明パーティクルを描画するシェーダー
export const SHADER_SRC = `
  // 頂点シェーダーでは Compute で生成した中心座標と色を受け取るだけにする。
  struct Camera { // カメラ行列と時間をまとめた構造体
    projection: mat4x4f, // 透視投影行列
    view: mat4x4f, // ビュー行列
    time: f32, // 時間（秒）
    padding: vec3f, // 16 バイト境界のためのパディング
  };

  @group(0) @binding(0) var<uniform> camera: Camera; // カメラ情報を Uniform で受け取る

  struct VertexOut { // ラスタライズへ渡す頂点出力
    @builtin(position) pos: vec4f, // クリップ空間位置
    @location(0) color: vec4f, // パーティクル色
    @location(1) uv: vec2f, // クアッド内の UV
  };

  const QUAD_POS = array<vec2f, 6>( // 2 つの三角形で作る板ポリ
    vec2f(-1.0, -1.0), // 左下
    vec2f(1.0, -1.0), // 右下
    vec2f(-1.0, 1.0), // 左上
    vec2f(-1.0, 1.0), // 左上（2 枚目）
    vec2f(1.0, -1.0), // 右下（2 枚目）
    vec2f(1.0, 1.0), // 右上
  );

  const QUAD_UV = array<vec2f, 6>( // クアッドの UV
    vec2f(0.0, 0.0), // 左下
    vec2f(1.0, 0.0), // 右下
    vec2f(0.0, 1.0), // 左上
    vec2f(0.0, 1.0), // 左上（2 枚目）
    vec2f(1.0, 0.0), // 右下（2 枚目）
    vec2f(1.0, 1.0), // 右上
  );

  @vertex // 頂点シェーダー宣言
  fn vertexMain(@builtin(vertex_index) vertIndex: u32, // 頂点インデックス
                @location(0) centerSize: vec4f, // パーティクル中心とサイズ
                @location(1) color: vec4f) -> VertexOut { // パーティクル色
    let viewCenter = (camera.view * vec4f(centerSize.xyz, 1.0)).xyz; // ワールド座標をビュー空間へ
    let quadOffset = QUAD_POS[vertIndex] * centerSize.w; // クアッドのローカルオフセット
    let viewVertex = vec4f(viewCenter + vec3f(quadOffset, 0.0), 1.0); // クアッド頂点の位置
    let clip = camera.projection * viewVertex; // クリップ空間へ変換
    return VertexOut(clip, color, QUAD_UV[vertIndex]); // 位置・色・UV を返す
  }

  @fragment // フラグメントシェーダー宣言
  fn fragmentMain(input: VertexOut) -> @location(0) vec4f { // 頂点出力を受け取る
    let dist = distance(input.uv, vec2f(0.5, 0.5)); // 中心からの距離
    let falloff = 1.0 - smoothstep(0.0, 0.6, dist); // 柔らかい減衰
    let intensity = falloff * falloff; // 発光強度の調整
    return vec4f(input.color.rgb * intensity, input.color.a * intensity); // 半透明で返す
  }
`;

// 新しい Compute Shader で全パーティクルのワールド座標と色をまとめて更新する。
export const COMPUTE_SHADER_SRC = `
  struct SimParams { // シミュレーション用パラメータ
    time: f32, // 現在時刻
    particleCount: f32, // パーティクル数
    padding: vec2f, // 16 バイト境界に揃えるための埋め
  };

  @group(0) @binding(0) var<uniform> params: SimParams; // パラメータ Uniform
  @group(0) @binding(1) var<storage, read> particleSeeds: array<vec4f>; // 初期シード

  struct ParticleState { // 1 パーティクルの状態
    centerSize: vec4f, // 中心とサイズ
    color: vec4f, // 色
  };

  @group(0) @binding(2) var<storage, read_write> particleStates: array<ParticleState>; // 書き込み先

  fn animate(seed: vec4f, time: f32) -> vec3f { // 位置アニメーションを計算
    let t = time * 0.35 + seed.x; // 時間にシードを混ぜる
    let lift = sin(t * 0.6 + seed.y) * 0.9; // 上下の揺れ
    let radius = 0.6 + fract(seed.y * 0.37) * 3.5; // 渦の半径
    let swirl = vec3f( // 渦巻きのオフセット
      cos(t) * radius, // X 方向
      lift + cos(t * 0.2 + seed.z) * 1.5, // Y 方向
      sin(t) * radius // Z 方向
    );
    return seed.xyz + swirl; // 初期位置に渦を加える
  }

  fn calcColor(seed: vec4f, time: f32) -> vec4f { // 色を計算
    let hueSeed = fract(seed.x * 0.17 + seed.z * 0.11); // 色相のシード
    let pulse = 0.5 + 0.5 * sin(time * 0.4 + hueSeed * 6.28318); // 点滅強度
    return vec4f( // RGBA を返す
      0.2 + 0.8 * pulse, // R
      0.1 + 0.6 * (1.0 - pulse), // G
      0.1 + 0.4 * pulse, // B
      0.35 + 0.35 * pulse // A
    );
  }

  @compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE}) // Compute シェーダー本体
  fn computeMain(@builtin(global_invocation_id) global_id: vec3<u32>) { // グローバル ID
    let index = global_id.x; // 1 次元のインデックス
    let count = u32(params.particleCount); // 処理対象の数
    if (index >= count) { // 範囲外なら終了
      return; // 早期リターン
    }

    let seed = particleSeeds[index]; // シード取得
    let centerWorld = animate(seed, params.time); // 位置を更新
    particleStates[index].centerSize = vec4f(centerWorld, seed.w); // 位置とサイズを書き込み
    particleStates[index].color = calcColor(seed, params.time); // 色を書き込み
  }
`;

export function createParticleSeeds() {
  const data = new Float32Array(PARTICLE_COUNT * 4); // シード用配列を確保
  for (let i = 0; i < PARTICLE_COUNT; ++i) { // パーティクル数だけ繰り返す
    const offset = i * 4; // 4 要素単位の開始位置
    data[offset + 0] = (Math.random() - 0.5) * PARTICLE_SPREAD * 2.0; // X 位置
    data[offset + 1] = (Math.random() - 0.5) * PARTICLE_SPREAD * 0.6; // Y 位置
    data[offset + 2] = (Math.random() - 0.5) * PARTICLE_SPREAD * 2.0; // Z 位置
    data[offset + 3] = PARTICLE_MIN_SIZE + Math.random() * (PARTICLE_MAX_SIZE - PARTICLE_MIN_SIZE); // サイズ
  }
  return data; // 完成したシードを返す
}
