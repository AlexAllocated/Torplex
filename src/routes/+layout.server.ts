export function load() {
  return {
    mockUi: process.env.TORPLEX_MOCK_UI === '1'
  };
}
