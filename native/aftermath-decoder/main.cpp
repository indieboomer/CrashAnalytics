// SDK interfaces follow NVIDIA's SDK Guide, How to Read Crash Dumps / JSON output.
// Compile against user-installed headers; no proprietary SDK files are distributed.
#include <d3d12.h>
#include <GFSDK_Aftermath.h>
#include <GFSDK_Aftermath_GpuCrashDumpDecoding.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>
#include <map>
#include <cstring>
#include <sstream>
#include <stdexcept>
using Bytes = std::vector<unsigned char>;
static Bytes read(const std::filesystem::path& p) {
  auto size = std::filesystem::file_size(p);
  if(size > 256ull*1024*1024) throw std::runtime_error("File size limit");
  std::ifstream stream(p, std::ios::binary);
  if(!stream) throw std::runtime_error("Cannot read input");
  Bytes data(static_cast<size_t>(size)); stream.read(reinterpret_cast<char*>(data.data()),data.size());
  if(!stream && size) throw std::runtime_error("Truncated input"); return data;
}
template<typename T> static std::string identity(const T& id) {
  // Binary SDK-defined identifier, not an approximate filename.
  return std::string(reinterpret_cast<const char*>(&id),sizeof(T));
}
static void check(GFSDK_Aftermath_Result r) {
  if(!GFSDK_Aftermath_SUCCEED(r) || r==GFSDK_Aftermath_Result_NotAvailable){
    std::ostringstream error;error<<"Aftermath result 0x"<<std::hex<<static_cast<unsigned>(r);throw std::runtime_error(error.str());
  }
}
struct Artifacts {
  std::map<std::string,Bytes> debug, shaders, sources;
  unsigned unresolved=0;
  void index(const std::filesystem::path& root) {
    if(root.empty()) return;
    unsigned count=0;
    for(auto& entry:std::filesystem::recursive_directory_iterator(root)) {
      if(++count>20000) throw std::runtime_error("Shader index entry limit");
      if(entry.is_symlink())throw std::runtime_error("Shader symlink prohibited");
      if(!entry.is_regular_file()) continue;
      auto extension=entry.path().extension().string();
      if(extension==".nvdbg") {
        auto data=read(entry.path()); GFSDK_Aftermath_ShaderDebugInfoIdentifier id={};
        auto r=GFSDK_Aftermath_GetShaderDebugInfoIdentifier(GFSDK_Aftermath_Version_API,data.data(),static_cast<uint32_t>(data.size()),&id);
        if(GFSDK_Aftermath_SUCCEED(r))debug.emplace(identity(id),std::move(data));
      } else if(extension==".dxil" || extension==".cso" || extension==".bin") {
        auto data=read(entry.path());D3D12_SHADER_BYTECODE bytecode={data.data(),data.size()};GFSDK_Aftermath_ShaderBinaryHash id={};
        auto r=GFSDK_Aftermath_GetShaderHash(GFSDK_Aftermath_Version_API,&bytecode,&id);
        if(GFSDK_Aftermath_SUCCEED(r))shaders.emplace(identity(id),data);
        GFSDK_Aftermath_ShaderDebugName name={};r=GFSDK_Aftermath_GetShaderDebugName(GFSDK_Aftermath_Version_API,&bytecode,&name);
        if(GFSDK_Aftermath_SUCCEED(r))sources.emplace(identity(name),std::move(data));
      }
    }
  }
  void lookup(const std::map<std::string,Bytes>& map,const std::string& id,PFN_GFSDK_Aftermath_SetData set) {
    const auto found=map.find(id);if(found==map.end()){++unresolved;return;}set(found->second.data(),static_cast<uint32_t>(found->second.size()));
  }
  static void debugLookup(const GFSDK_Aftermath_ShaderDebugInfoIdentifier* id,PFN_GFSDK_Aftermath_SetData set,void* user){auto& a=*static_cast<Artifacts*>(user);a.lookup(a.debug,identity(*id),set);}
  static void shaderLookup(const GFSDK_Aftermath_ShaderBinaryHash* id,PFN_GFSDK_Aftermath_SetData set,void* user){auto& a=*static_cast<Artifacts*>(user);a.lookup(a.shaders,identity(*id),set);}
  static void sourceLookup(const GFSDK_Aftermath_ShaderDebugName* id,PFN_GFSDK_Aftermath_SetData set,void* user){auto& a=*static_cast<Artifacts*>(user);a.lookup(a.sources,identity(*id),set);}
};
int main(int argc,char** argv) {
  GFSDK_Aftermath_GpuCrashDump_Decoder decoder={};
  try {
    if(argc==2 && std::string(argv[1])=="--version") {std::cout<<"crashlab-decoder/1 SDK API "<<GFSDK_Aftermath_Version_API<<"\n";return 0;}
    std::filesystem::path input,output,shaders;
    for(int i=1;i<argc;i+=2){if(i+1>=argc)throw std::runtime_error("Missing option value");auto option=std::string(argv[i]);if(option=="--input")input=argv[i+1];else if(option=="--output")output=argv[i+1];else if(option=="--shader-artifacts")shaders=argv[i+1];else throw std::runtime_error("Unknown option");}
    if(input.empty()||output.empty())throw std::runtime_error("Usage: aftermath-decoder --input dump --output raw-json [--shader-artifacts directory]");
    auto data=read(input);Artifacts artifacts;artifacts.index(shaders);
    check(GFSDK_Aftermath_GpuCrashDump_CreateDecoder(GFSDK_Aftermath_Version_API,data.data(),static_cast<uint32_t>(data.size()),&decoder));
    uint32_t size=0;
    check(GFSDK_Aftermath_GpuCrashDump_GenerateJSON(decoder,GFSDK_Aftermath_GpuCrashDumpDecoderFlags_ALL_INFO,GFSDK_Aftermath_GpuCrashDumpFormatterFlags_CONDENSED_OUTPUT,Artifacts::debugLookup,Artifacts::shaderLookup,Artifacts::sourceLookup,&artifacts,&size));
    if(!size || size>256u*1024*1024)throw std::runtime_error("JSON output size limit");
    std::vector<char> json(size);check(GFSDK_Aftermath_GpuCrashDump_GetJSON(decoder,size,json.data()));
    std::ofstream stream(output,std::ios::binary);if(!stream)throw std::runtime_error("Cannot write output");
    stream.write(json.data(),size && json.back()==0?size-1:size);if(!stream)throw std::runtime_error("Output write failed");
    std::cerr<<"unresolved_shader_lookups="<<artifacts.unresolved<<"; source mapping must be checked in JSON\n";
    check(GFSDK_Aftermath_GpuCrashDump_DestroyDecoder(decoder));return 0;
  }catch(const std::exception& e){if(decoder)GFSDK_Aftermath_GpuCrashDump_DestroyDecoder(decoder);std::cerr<<e.what()<<"\n";return 2;}
}
