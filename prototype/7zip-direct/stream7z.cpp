#include <emscripten.h>
#include <stdio.h>
#include "../../../Common/MyCom.h"
#include "../../../Common/MyString.h"
#include "../../Archive/IArchive.h"
#include "../../Archive/7z/7zHandler.h"
#include "../../../Windows/PropVariant.h"

using namespace NArchive;

EM_JS(int, js_read, (int id, unsigned char *p, int n), {
  const f = Module['stream7zRead'];
  if (typeof f !== 'function') return -1;
  return f(id, HEAPU8.subarray(p, p + n)) | 0;
});
EM_JS(int, js_write, (int id, const unsigned char *p, int n), {
  const f = Module['stream7zWrite'];
  if (typeof f !== 'function') return -1;
  return f(id, HEAPU8.subarray(p, p + n)) | 0;
});
EM_JS(double, js_heap_size, (), { return HEAPU8.buffer.byteLength; });

static char g_error[512];

class CJsInStream Z7_final: public ISequentialInStream, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_1(ISequentialInStream)
  Z7_IFACE_COM7_IMP(ISequentialInStream)
public:
  int Id;
  explicit CJsInStream(int id): Id(id) {}
};
Z7_COM7F_IMF(CJsInStream::Read(void *data, UInt32 size, UInt32 *processedSize)) {
  const int n = js_read(Id, (unsigned char *)data, (int)size);
  if (n < 0) return E_FAIL;
  if (processedSize) *processedSize = (UInt32)n;
  return S_OK;
}

class CJsOutStream Z7_final: public ISequentialOutStream, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_1(ISequentialOutStream)
  Z7_IFACE_COM7_IMP(ISequentialOutStream)
public:
  int Id;
  explicit CJsOutStream(int id): Id(id) {}
};
Z7_COM7F_IMF(CJsOutStream::Write(const void *data, UInt32 size, UInt32 *processedSize)) {
  const int n = js_write(Id, (const unsigned char *)data, (int)size);
  if (n < 0 || (UInt32)n != size) return E_FAIL;
  if (processedSize) *processedSize = (UInt32)n;
  return S_OK;
}

class CUpdateCallback Z7_final: public IArchiveUpdateCallback, public CMyUnknownImp {
  Z7_COM_UNKNOWN_IMP_2(IArchiveUpdateCallback, IProgress)
  Z7_IFACE_COM7_IMP(IProgress)
  Z7_IFACE_COM7_IMP(IArchiveUpdateCallback)
public:
  int SourceId;
  UString Name;
  UInt64 Size;
  CUpdateCallback(int sourceId, const wchar_t *name, UInt64 size):
    SourceId(sourceId), Name(name), Size(size) {}
};
Z7_COM7F_IMF(CUpdateCallback::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(CUpdateCallback::SetCompleted(const UInt64 *)) { return S_OK; }
Z7_COM7F_IMF(CUpdateCallback::GetUpdateItemInfo(
    UInt32, Int32 *newData, Int32 *newProps, UInt32 *indexInArchive)) {
  if (newData) *newData = 1;
  if (newProps) *newProps = 1;
  if (indexInArchive) *indexInArchive = (UInt32)(Int32)-1;
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::GetProperty(UInt32, PROPID propID, PROPVARIANT *value)) {
  NWindows::NCOM::CPropVariant prop;
  switch (propID) {
    case kpidPath: prop = Name; break;
    case kpidIsDir: prop = false; break;
    case kpidSize: prop = Size; break;
    case kpidAttrib: prop = (UInt32)0; break;
    case kpidIsAnti: prop = false; break;
  }
  prop.Detach(value);
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::GetStream(UInt32, ISequentialInStream **inStream)) {
  CMyComPtr<ISequentialInStream> stream = new CJsInStream(SourceId);
  *inStream = stream.Detach();
  return S_OK;
}
Z7_COM7F_IMF(CUpdateCallback::SetOperationResult(Int32 result)) {
  return result == NUpdate::NOperationResult::kOK ? S_OK : E_FAIL;
}

static UString AsciiName(const char *s) {
  UString out;
  while (*s) {
    const unsigned char c = (unsigned char)*s++;
    if (c >= 0x80) return UString();
    out.Add_Char((wchar_t)c);
  }
  return out;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE const char *stream7z_last_error() { return g_error; }
EMSCRIPTEN_KEEPALIVE double stream7z_heap_size() { return js_heap_size(); }

EMSCRIPTEN_KEEPALIVE
int stream7z_create(int sourceId, int outputId, const char *memberName, double sizeDouble) {
  g_error[0] = 0;
  if (!memberName || sizeDouble < 0 || sizeDouble > 9007199254740991.0) {
    snprintf(g_error, sizeof(g_error), "invalid arguments");
    return -1;
  }
  const UInt64 size = (UInt64)sizeDouble;
  if ((double)size != sizeDouble) {
    snprintf(g_error, sizeof(g_error), "size must be an integer");
    return -1;
  }
  const UString name = AsciiName(memberName);
  if (name.IsEmpty() && memberName[0]) {
    snprintf(g_error, sizeof(g_error), "member name must be ASCII");
    return -1;
  }

  NArchive::N7z::CHandler *handlerSpec = new NArchive::N7z::CHandler;
  CMyComPtr<IOutArchive> archive = handlerSpec;
  const wchar_t *names[] = { L"x", L"0", L"s", L"tm" };
  NWindows::NCOM::CPropVariant values[4] = {
    (UInt32)5, L"LZMA2:d=32m:mt=1", true, false
  };
  HRESULT hr = S_OK;
  for (unsigned i = 0; i < 4; ++i) {
    hr = handlerSpec->SetProperty(names[i], values[i]);
    if (hr != S_OK) {
      snprintf(g_error, sizeof(g_error), "SetProperty failed: 0x%08x", (unsigned)hr);
      return -1;
    }
  }

  CMyComPtr<ISequentialOutStream> out = new CJsOutStream(outputId);
  CMyComPtr<IArchiveUpdateCallback> callback = new CUpdateCallback(sourceId, name, size);
  hr = archive->UpdateItems(out, 1, callback);
  if (hr != S_OK) {
    snprintf(g_error, sizeof(g_error), "UpdateItems failed: 0x%08x", (unsigned)hr);
    return -1;
  }
  return 0;
}
}
