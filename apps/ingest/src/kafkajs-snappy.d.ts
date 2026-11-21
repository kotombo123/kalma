declare module 'kafkajs-snappy' {
  /** kafkajs codec factory: `CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec`. */
  const SnappyCodec: () => {
    compress(encoder: { buffer: Buffer }): Promise<Buffer>;
    decompress(buffer: Buffer): Promise<Buffer>;
  };
  export default SnappyCodec;
}
