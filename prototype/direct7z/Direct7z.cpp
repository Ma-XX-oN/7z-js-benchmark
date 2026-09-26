#include "StdAfx.h"

#include <emscripten.h>
#include <stdint.h>
#include <stdio.h>

#include "../../../Common/MyCom.h"
#include "../../../Windows/PropVariant.h"
#include "../../Archive/IArchive.h"
#include "../../IStream.h"
#include "../../PropID.h"
#include "../../Archive/7z/7zHandler.h"

using namespace NWindows;
using namespace NWindows::NCOM;

static char g_error[512];

EM_JS(int, js_read, (int sourceId, void *data, int size), {
  const fn = Module['stream7zRead'];
  if (typeof fn !== 'function') return -1;
  return fn(sourceId, HEAPU8.subarray(data, data + size)) | 0;
});

EM_JS(int, js_write_at, (int outputId, double pos, const void *data, int size), {
  const fn = Module['stream7zWriteAt'];
  if (typeof fn !== 'function') return -1;
  return fn(outputId, pos, HEAPU8.subarray(data, data + size)) | 0;
});

EM_JS(int, js_set_size, (int outputId, double size), {
  const fn = Module['stream7zSetSize'];
  if (typeof fn !== 'function') return -1;
  return fn(outputId, size) | 0;
});

Z7_CLASS_IMP_COM_1(CJsInStream, ISequentialInStream)
  int _sourceId;
public:
  explicit CJsInStream(int sourceId): _sourceId(sourceId) {}
};

Z7_COM7F_IMF(CJsInStream::Read(void *data, UInt32 size, UInt32 *processedSize))
{
  if (!processedSize) return E_INVALIDARG;
  const int n = js_read(_sourceId, data, (int)size);
  if (n < 0 || (UInt32)n > size) return E_FAIL;
  *processedSize = (UInt32)n;
  return S_OK;
}

Z7_CLASS_IMP_COM_1(CJsOutStream, IOutStream)
  int _outputId;
  UInt64 _pos;
  UInt64 _size;
public:
  explicit CJsOutStream(int outputId): _outputId(outputId), _pos(0), _size(0) {}
};

Z7_COM7F_IMF(CJsOutStream::Write(const void *data, UInt32 size, UInt32 *processedSize))
{
  if (!processedSize) return E_INVALIDARG;
  const int n = js_write_at(_outputId, (double)_pos, data, (int)size);
  if (n < 0 || (UInt32)n > size) return E_FAIL;
  _pos += (UInt32)n;
  if (_pos > _size) _size = _pos;
  *processedSize = (UInt32)n;
  return n == 0 && size != 0 ? E_FAIL : S_OK;
}

Z7_COM7F_IMF(CJsOutStream::Seek(Int64 offset, UInt32 origin, UInt64 *newPosition))
{
  Int64 base;
  if (origin == STREAM_SEEK_SET) base = 0;
  else if (origin == STREAM_SEEK_CUR) base = (Int64)_pos;
  else if (origin == STREAM_SEEK_END) base = (Int64)_size;
  else return STG_E_INVALIDFUNCTION;
  const Int64 next = base + offset;
  if (next < 0) return HRESULT_WIN32_ERROR_NEGATIVE_SEEK;
  _pos = (UInt64)next;
  if (newPosition) *newPosition = _pos;
  return S_OK;
}

Z7_COM7F_IMF(CJsOutStream::SetSize(UInt64 newSize))
{
  if (js_set_size(_outputId, (double)newSize) != 0) return E_FAIL;
  _size = newSize;
  if (_pos > _size) _pos = _size;
  return S_OK;
}

Z7_CLASS_IMP_COM_1(CUpdateCallback, IArchiveUpdateCallback)
  int _sourceId;
  UString _name;
  UInt64 _size;
public:
  CUpdateCallback(int sourceId, const wchar_t *name, UInt64 size):
      _sourceId(sourceId), _name(name), _size(size) {}
};

Z7_COM7F_IMF(CUpdateCallback::SetTotal(UInt64)) { return S_OK; }
Z7_COM7F_IMF(CUpdateCallback::SetCompleted(const UInt64 *)) { return S_OK; }

Z7_COM7F_IMF(CUpdateCallback::GetUpdateItemInfo(
    UInt32 index, Int32 *newData, Int32 *newProps, UInt32 *indexInArchive))
{
  if (index != 0) return E_INVALIDARG;
  *newData = 1;
  *newProps = 1;
  *indexInArchive = (UInt32)(Int32)-1;
  return S_OK;
}

Z7_COM7F_IMF(CUpdateCallback::GetProperty(
    UInt32 index, PROPID propID, PROPVARIANT *value))
{
  if (index != 0) return E_INVALIDARG;
  CPropVariant prop;
  switch (propID) {
    case kpidPath: prop = _name; break;
    case kpidIsDir: prop = false; break;
    case kpidSize: prop = _size; break;
    default: break;
  }
  prop.Detach(value);
  return S_OK;
}

Z7_COM7F_IMF(CUpdateCallback::GetStream(
    UInt32 index, ISequentialInStream **inStream))
{
  if (index != 0 || !inStream) return E_INVALIDARG;
  CJsInStream *stream = new CJsInStream(_sourceId);
  stream->AddRef();
  *inStream = stream;
  return S_OK;
}

Z7_COM7F_IMF(CUpdateCallback::SetOperationResult(Int32 operationResult))
{
  return operationResult == 0 ? S_OK : E_FAIL;
}

static void set_error(const char *where, HRESULT hr)
{
  snprintf(g_error, sizeof(g_error), "%s failed: 0x%08x", where, (unsigned)hr);
}

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char *stream7z_last_error() { return g_error; }

EMSCRIPTEN_KEEPALIVE
int stream7z_create_archive(
    int sourceId, int outputId, const wchar_t *memberName, double sizeDouble)
{
  g_error[0] = 0;
  if (!memberName || sizeDouble < 0 || sizeDouble > 9007199254740991.0)
    return -1;
  const UInt64 size = (UInt64)sizeDouble;
  if ((double)size != sizeDouble) return -1;

  CMyComPtr<IOutArchive> archive = new NArchive::N7z::CHandler();
  CMyComPtr<ISetProperties> props;
  HRESULT hr = archive.QueryInterface(IID_ISetProperties, &props);
  if (hr != S_OK) { set_error("QueryInterface(ISetProperties)", hr); return -1; }

  const wchar_t *names[] = { L"x", L"0", L"d", L"s", L"mt", L"tm", L"tr" };
  CPropVariant values[7];
  values[0] = (UInt32)5;
  values[1] = L"LZMA2";
  values[2] = (UInt32)(32u << 20);
  values[3] = true;
  values[4] = (UInt32)1;
  values[5] = false;
  values[6] = false;
  hr = props->SetProperties(names, values, 7);
  if (hr != S_OK) { set_error("SetProperties", hr); return -1; }

  CMyComPtr<ISequentialOutStream> out = new CJsOutStream(outputId);
  CMyComPtr<IArchiveUpdateCallback> callback =
      new CUpdateCallback(sourceId, memberName, size);
  hr = archive->UpdateItems(out, 1, callback);
  if (hr != S_OK) { set_error("UpdateItems", hr); return -1; }
  return 0;
}

}
