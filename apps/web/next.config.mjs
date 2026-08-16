const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/**/*': ['./../packages/database/generated/client/**'],
  },
};

export default config;
